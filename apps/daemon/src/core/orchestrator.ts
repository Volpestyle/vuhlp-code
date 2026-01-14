import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { EventBus } from "./eventBus.js";
import { RunStore } from "./store.js";
import { nowIso } from "./time.js";
import {
  NodeRecord,
  EdgeRecord,
  RoleId,
  InteractionMode,
  RunMode,
  RunPhase,
  NodeControl,
  TurnPolicy,
  DocsInventory,
  DocsIterationPlan,
  DocAgentRole,
  RepoFacts,
  AcceptanceCriterion,
  TaskDagRecord,
  TaskStep,
  AutoPausePolicy,
  Envelope,
  ManualTurnOptions,
  GlobalMode,
} from "./types.js";
import { ContextPackBuilder } from "./contextPackBuilder.js";
import { PromptQueue } from "./promptQueue.js";
import { ApprovalQueue } from "./approvalQueue.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { ProviderRegistry } from "../providers/registry.js";
import { ProviderAdapter, ProviderOutputEvent } from "../providers/types.js";
import { WorkspaceManager } from "./workspace.js";
import { Semaphore } from "./scheduler.js";
import { verifyAll } from "./verifier.js";
import { ChatManager } from "./chatManager.js";
import fs from "node:fs";

import { PromptFactory } from "./promptFactory.js";
import { DocsIterationWorkflow } from "./workflows/docsIteration.js";
import { DocsSyncWorkflow } from "./workflows/docsSync.js";

import { NodeExecutor } from "./nodeExecutor.js";
import { GraphScheduler } from "./graphScheduler.js";

// Graph Command Types
interface GraphCommandSpawn {
  command: "spawn_node";
  args: {
    role: RoleId; // e.g. "implementer"
    label: string; // e.g. "Frontend Builder"
    instructions: string; // e.g. "Build the login page..."
    input?: Record<string, unknown>;
    taskId?: string;
  };
}

type GraphCommand = GraphCommandSpawn;

function parseGraphCommand(text: string): GraphCommand | null {
  try {
    // Look for JSON block
    const match = text.match(/```json\s*(\{[\s\S]*?"command"\s*:\s*"spawn_node"[\s\S]*?\})\s*```/) ||
      text.match(/(\{[\s\S]*?"command"\s*:\s*"spawn_node"[\s\S]*?\})/);

    if (match) {
      const json = JSON.parse(match[1]);
      if (json.command === "spawn_node" && json.args) {
        return json as GraphCommand;
      }
    }
  } catch (e) {
    // ignore parse errors
  }
  return null;
}

export interface OrchestratorConfig {
  roles: Record<string, string>;
  scheduler: { maxConcurrency: number };
  orchestration: { maxIterations: number; maxTurnsPerNode?: number };
  verification: { commands: string[] };
  planning?: { docsDirectory?: string };
  workspace?: { cleanupOnDone?: boolean };
}

export interface CreateRunParams {
  prompt: string;
  repoPath: string;
  configSnapshot: Record<string, unknown>;
}

type VerificationCommandReport = {
  command: string;
  ok: boolean;
  code: number | null;
  durationMs: number;
  logArtifactId?: string;
};

type VerificationReport = {
  ok: boolean;
  commands: VerificationCommandReport[];
  docsCheck: { ok: boolean; missing: string[] };
};

type VerificationResult = {
  ok: boolean;
  report: VerificationReport;
  reportArtifactId?: string;
};

type DocsSyncResult = {
  ok: boolean;
  hasChanges: boolean;
  summary: string;
};

type CompletionReport = {
  ok: boolean;
  stepsOk: boolean;
  acceptanceOk: boolean;
  docsSynced: boolean;
  issues: string[];
  acceptanceFailures: AcceptanceCriterion[];
};

type NormalizedPlan = {
  taskDag: TaskDagRecord;
  acceptanceCriteria: AcceptanceCriterion[];
  usedFallback: boolean;
};

export class OrchestratorEngine {
  private store: RunStore;
  private bus: EventBus;
  private providers: ProviderRegistry;
  private workspace: WorkspaceManager;
  private cfg: OrchestratorConfig;
  private chatManager: ChatManager;
  private contextPackBuilder: ContextPackBuilder;
  private promptQueue: PromptQueue;
  private approvalQueue: ApprovalQueue;
  private sessionRegistry: SessionRegistry;

  // Refactored components
  private promptFactory: PromptFactory;
  private docsIterationWorkflow: DocsIterationWorkflow;
  private docsSyncWorkflow: DocsSyncWorkflow;

  // NEW Components
  public nodeExecutor: NodeExecutor;
  private scheduler: GraphScheduler;

  constructor(params: {
    store: RunStore;
    bus: EventBus;
    providers: ProviderRegistry;
    workspace: WorkspaceManager;
    cfg: OrchestratorConfig;
    chatManager: ChatManager;
    promptQueue: PromptQueue;
    approvalQueue: ApprovalQueue;
    sessionRegistry: SessionRegistry;
  }) {
    this.store = params.store;
    this.bus = params.bus;
    this.providers = params.providers;
    this.workspace = params.workspace;
    this.cfg = params.cfg;
    this.chatManager = params.chatManager;
    this.contextPackBuilder = new ContextPackBuilder();
    this.promptQueue = params.promptQueue;
    this.approvalQueue = params.approvalQueue;
    this.sessionRegistry = params.sessionRegistry;

    this.promptFactory = new PromptFactory(this.cfg);

    // Initialize New Components
    this.nodeExecutor = new NodeExecutor(
      this.store,
      this.bus,
      this.providers,
      this.workspace,
      this.sessionRegistry,
      this.approvalQueue,
      this.promptFactory,
      this.executeGraphCommand.bind(this),
      this.transitionPhase.bind(this)
    );

    this.scheduler = new GraphScheduler(
      this.store,
      this.bus,
      this.chatManager,
      this.nodeExecutor,
      { maxConcurrency: this.cfg.scheduler.maxConcurrency }
    );

    // Initialize Workflows with context adapter
    // We bind methods to 'this' to ensure correct context when called by workflows
    const workflowContext: any = {
      store: this.store,
      bus: this.bus,
      providers: this.providers,
      cfg: this.cfg,
      createTaskNode: this.createTaskNode.bind(this),
      createEdge: this.createEdge.bind(this),
      runProviderNode: this.runProviderNode.bind(this),
      checkPause: () => Promise.resolve(), // No-op for now in workflow context shim
      shouldStopScheduling: () => false,
      pauseSignals: new Map(), // shim
      roleProvider: this.roleProvider.bind(this),
      detectDocsInventory: this.detectDocsInventory.bind(this),
      transitionPhase: this.transitionPhase.bind(this),
    };

    this.docsIterationWorkflow = new DocsIterationWorkflow(workflowContext, this.promptFactory);
    this.docsSyncWorkflow = new DocsSyncWorkflow(workflowContext, this.promptFactory);
  }

  /** Get the ChatManager for external access (API endpoints). */
  getChatManager(): ChatManager {
    return this.chatManager;
  }

  isRunning(runId: string): boolean {
    return this.store.getRun(runId)?.status === 'running';
  }

  stopRun(runId: string): boolean {
    this.scheduler.stop(runId);
    this.bus.emitRunPatch(runId, { id: runId, status: "failed" }, "run.failed");
    return true;
  }

  stopNode(runId: string, nodeId: string): boolean {
    // Pass through to executor/scheduler if they support granular stop
    return true;
  }

  pauseRun(runId: string): boolean {
    this.scheduler.pause(runId);
    this.bus.emitRunPatch(runId, { id: runId, status: "paused" }, "run.paused");
    return true;
  }

  resumeRun(runId: string, feedback?: string): boolean {
    if (feedback) {
      this.store.createArtifact({
        runId,
        nodeId: this.store.getRun(runId)?.rootOrchestratorNodeId ?? "unknown",
        kind: "user_feedback",
        name: `feedback_${Date.now()}.txt`,
        mimeType: "text/plain",
        content: feedback,
      });
    }
    this.scheduler.resume(runId);
    this.bus.emitRunPatch(runId, { id: runId, status: "running" }, "run.resumed");
    return true;
  }

  restartNode(runId: string, nodeId: string): boolean {
    const run = this.store.getRun(runId);
    if (!run) return false;
    const node = run.nodes[nodeId];
    if (!node) return false;

    // We can only restart if it's not currently running (to be safe, though scheduler might handle it)
    // Actually, force-restart is fine if we want to interrupt? 
    // But usually this is for "Disconnected" (completed/failed) nodes.

    // Reset status to queued
    node.status = "queued";
    // Clear error if any?
    delete node.error;

    this.store.persistRun(run);
    this.bus.emitNodePatch(runId, nodeId, { status: "queued", error: undefined }, "node.progress");

    // Ensure run is running so scheduler picks it up
    if (run.status !== "running") {
      this.resumeRun(runId);
    }

    return true;
  }

  /**
   * Interrupt the current execution and inject a chat message.
   */
  interruptWithMessage(runId: string, content: string, nodeId?: string): boolean {
    // Store message
    this.chatManager.sendMessage({
      runId,
      nodeId,
      content,
      interrupt: true,
    });

    // Pause scheduler
    this.scheduler.pause(runId);

    // Resume shorty after
    setTimeout(() => {
      this.scheduler.resume(runId);
    }, 50);

    return true;
  }

  queueMessage(runId: string, content: string, nodeId?: string): boolean {
    if (!this.store.getRun(runId)) return false;
    this.chatManager.queueMessage(runId, content, nodeId);
    return true;
  }

  getInteractionMode(runId: string, nodeId?: string): InteractionMode {
    return this.chatManager.getInteractionMode(runId, nodeId);
  }

  setInteractionMode(runId: string, mode: InteractionMode, nodeId?: string): boolean {
    if (!this.store.getRun(runId)) return false;
    this.chatManager.setInteractionMode(runId, nodeId, mode);
    return true;
  }

  setRunMode(runId: string, mode: RunMode, reason?: string): boolean {
    const run = this.store.getRun(runId);
    if (!run) return false;
    const previousMode = run.mode;
    run.mode = mode;
    this.store.persistRun(run);

    // Notify scheduler
    this.scheduler.setInteractionMode(runId, mode === "INTERACTIVE");

    this.bus.emitRunModeChanged(runId, mode, previousMode, reason ?? "user_request", 0);
    return true;
  }

  setGlobalMode(runId: string, mode: GlobalMode): boolean {
    const run = this.store.getRun(runId);
    if (!run) return false;

    // Only update if changed
    if (run.globalMode === mode) return true;

    run.globalMode = mode;
    this.store.persistRun(run);

    // Emit generic patch for UI to update
    this.bus.emitRunPatch(runId, { id: runId, globalMode: mode }, "run.updated");

    // Also notify via progress to make it visible in logs
    this.bus.emitNodeProgress(
      runId,
      run.rootOrchestratorNodeId,
      `SYSTEM: Global Mode switched to ${mode}`
    );

    return true;
  }

  getNodeControl(runId: string, nodeId: string): NodeControl | null {
    const run = this.store.getRun(runId);
    return run?.nodes[nodeId]?.control ?? null;
  }

  setNodeControl(runId: string, nodeId: string, control: NodeControl): boolean {
    const run = this.store.getRun(runId);
    if (!run || !run.nodes[nodeId]) return false;
    const prev = run.nodes[nodeId].control;
    run.nodes[nodeId].control = control;
    this.store.persistRun(run);
    this.bus.emitNodeControlChanged(runId, nodeId, control, prev ?? "AUTO");
    return true;
  }

  // ... (Legacy helper methods like roleProvider, detectRepoFacts remain as private helpers or moved to utils)

  private roleProvider(role: RoleId): ProviderAdapter {
    const providerId = this.cfg.roles[role] ?? "mock";
    const p = this.providers.get(providerId);
    if (!p) throw new Error(`Provider not configured: ${providerId} (role=${role})`);
    return p;
  }

  private detectDocsInventory(repoPath: string): DocsInventory {
    const docsDir = path.join(repoPath, this.cfg.planning?.docsDirectory ?? "docs");
    const inventory: DocsInventory = {
      hasOverview: false,
      hasArchitecture: false,
      hasPlan: false,
      hasAcceptance: false,
      hasDecisions: false,
      files: [],
      missingRequired: [],
    };

    if (!fs.existsSync(docsDir)) {
      inventory.missingRequired = ["OVERVIEW.md", "ARCHITECTURE.md", "PLAN.md", "ACCEPTANCE.md"];
      return inventory;
    }

    try {
      const files = fs.readdirSync(docsDir);
      inventory.files = files.filter((f) => f.endsWith(".md"));

      inventory.hasOverview = files.some((f) => f.toLowerCase().includes("overview"));
      inventory.hasArchitecture = files.some((f) => f.toLowerCase().includes("architecture"));
      inventory.hasPlan = files.some((f) => f.toLowerCase().includes("plan"));
      inventory.hasAcceptance = files.some((f) => f.toLowerCase().includes("acceptance"));
      inventory.hasDecisions = files.some((f) => f.toLowerCase().includes("decision"));

      // Check for missing required docs
      if (!inventory.hasOverview) inventory.missingRequired.push("OVERVIEW.md");
      if (!inventory.hasArchitecture) inventory.missingRequired.push("ARCHITECTURE.md");
      if (!inventory.hasPlan) inventory.missingRequired.push("PLAN.md");
      if (!inventory.hasAcceptance) inventory.missingRequired.push("ACCEPTANCE.md");
    } catch {
      inventory.missingRequired = ["OVERVIEW.md", "ARCHITECTURE.md", "PLAN.md", "ACCEPTANCE.md"];
    }

    return inventory;
  }

  /**
   * Detect repo facts during BOOT/INVESTIGATE phase.
   */
  private detectRepoFacts(repoPath: string): RepoFacts {
    const facts: RepoFacts = {
      language: "unknown",
      languages: [],
      entrypoints: [],
      testCommands: [],
      buildCommands: [],
      lintCommands: [],
      hasTests: false,
      hasDocs: false,
      isEmptyRepo: true,
      isGitRepo: false,
    };

    try {
      const entries = fs.readdirSync(repoPath);
      // Check for .git directory
      if (entries.includes(".git")) {
        facts.isGitRepo = true;
      }
      const visibleEntries = entries.filter((entry) => entry !== ".git" && entry !== ".vuhlp");
      facts.isEmptyRepo = visibleEntries.length === 0;
      facts.hasDocs = fs.existsSync(path.join(repoPath, "docs"));
      facts.hasOnlyDocs = visibleEntries.length > 0 && visibleEntries.every((entry) => entry === "docs");
      facts.hasCode = visibleEntries.some((entry) => entry !== "docs");

      // Detect language and package manager
      if (fs.existsSync(path.join(repoPath, "package.json"))) {
        facts.language = "typescript";
        facts.languages = ["typescript", "javascript"];
        facts.packageManager = fs.existsSync(path.join(repoPath, "pnpm-lock.yaml"))
          ? "pnpm"
          : fs.existsSync(path.join(repoPath, "yarn.lock"))
            ? "yarn"
            : "npm";

        // Infer commands from package.json
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, "package.json"), "utf-8"));
          const scripts = pkg.scripts ?? {};
          if (scripts.test) facts.testCommands = [`${facts.packageManager} test`];
          if (scripts.build) facts.buildCommands = [`${facts.packageManager} run build`];
          if (scripts.lint) facts.lintCommands = [`${facts.packageManager} run lint`];
          facts.hasTests = Boolean(scripts.test);
          facts.entrypoints = pkg.main ? [pkg.main] : [];
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    return facts;
  }

  private transitionPhase(runId: string, newPhase: RunPhase, reason?: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    const prev = run.phase;
    run.phase = newPhase;
    this.store.persistRun(run);
    this.bus.emitRunPhaseChanged(runId, newPhase, prev, reason);
  }

  private createTaskNode(params: { runId: string; parentNodeId: string; label: string; role: RoleId; providerId: string; input?: unknown; taskId?: string }): NodeRecord {
    const id = randomUUID();
    const node: NodeRecord = {
      id, runId: params.runId, parentNodeId: params.parentNodeId, type: "task", label: params.label, role: params.role,
      providerId: params.providerId, taskId: params.taskId, status: "queued", createdAt: nowIso(), input: params.input, triggerMode: "any_input"
    };
    this.bus.emitNodePatch(params.runId, id, node, "node.created");
    return node;
  }

  public createEdge(runId: string, from: string, to: string, type: EdgeRecord["type"], label?: string): void {
    const id = randomUUID();
    const edge: EdgeRecord = {
      id, runId, from, to, type, label, createdAt: nowIso(), deliveryPolicy: "queue", pendingEnvelopes: []
    };
    this.store.addEdge(runId, edge);
    this.bus.emitEdge(runId, edge);
  }

  private executeGraphCommand(runId: string, parentNodeId: string, cmd: GraphCommand): string {
    if (cmd.command === "spawn_node") {
      const { role, label, instructions, input } = cmd.args;

      // 1. Create the new node
      const newNode = this.createTaskNode({
        runId,
        parentNodeId,
        role: role ?? "implementer",
        label: label ?? "Agent",
        providerId: this.cfg.roles[role] ?? "mock", // Resolve provider from role
        taskId: cmd.args.taskId, // Pass the Task ID context
        input: {
          ...input,
          initialInstructions: instructions // Pass instructions to the new node
        }
      });
      // Force persist
      const run = this.store.getRun(runId);
      if (run) {
        run.nodes[newNode.id] = newNode;
        this.store.persistRun(run);
      }

      // 2. Create Connecton (Parent -> Child) (Handoff)
      this.createEdge(runId, parentNodeId, newNode.id, "handoff", "delegates-to");

      // 3. Create Report Edge (Child -> Parent)
      this.createEdge(runId, newNode.id, parentNodeId, "report", "reports-to");

      this.bus.emitNodeProgress(runId, parentNodeId, `[GRAPH] Spawned node '${label}' (${newNode.id})`);
      return `[SYSTEM] Graph Command Executed: Node '${label}' (${newNode.id}) created and connected.\n`;
    }
    return "";
  }

  public spawnNode(runId: string, params: {
    label: string;
    role?: RoleId;
    providerId: string;
    parentNodeId?: string;
    input?: Record<string, unknown>;
  }): NodeRecord {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const parentNodeId = params.parentNodeId ?? run.rootOrchestratorNodeId;

    const newNode = this.createTaskNode({
      runId,
      parentNodeId,
      label: params.label,
      role: params.role ?? "implementer",
      providerId: params.providerId,
      input: params.input
    });

    // Persist
    run.nodes[newNode.id] = newNode;
    this.store.persistRun(run);

    // Auto-connect to parent (bilateral handoff/report)
    this.createEdge(runId, parentNodeId, newNode.id, "handoff", "delegates-to");
    this.createEdge(runId, newNode.id, parentNodeId, "report", "reports-to");

    return newNode;
  }

  async manualTurn(
    runId: string,
    nodeId: string,
    userMessage: string,
    options?: ManualTurnOptions
  ): Promise<{ success: boolean; error?: string; output?: unknown }> {
    return this.nodeExecutor.executeManual(runId, nodeId, userMessage, () => {
      const run = this.store.getRun(runId);
      const rootNodeId = run?.rootOrchestratorNodeId;
      const rootNode = rootNodeId ? run?.nodes[rootNodeId] : undefined;
      const rootIsTerminated = rootNode && (rootNode.status === "completed" || rootNode.status === "failed" || rootNode.status === "skipped");
      const isRoot = nodeId === rootNodeId;

      let shouldAdoptOrphans = isRoot;
      if (!shouldAdoptOrphans && rootIsTerminated) {
        const activeNodeIds = Object.keys(run?.nodes ?? {})
          .filter(id => {
            const n = run!.nodes[id];
            return n.status === "queued" || n.status === "running";
          })
          .sort();
        shouldAdoptOrphans = activeNodeIds.length > 0 && activeNodeIds[0] === nodeId;
      }

      const result = this.chatManager.consumeMessages(runId, (msg) => {
        if (msg.nodeId === nodeId || msg.nodeId === undefined) return true;
        if (shouldAdoptOrphans && msg.nodeId) {
          const target = run?.nodes[msg.nodeId];
          if (target && (target.status === "completed" || target.status === "failed" || target.status === "skipped")) {
            return true;
          }
        }
        return false;
      });

      return result.formatted;
    });
  }

  async startRun(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const rootNodeId = run.rootOrchestratorNodeId;

    this.bus.emitRunPatch(runId, { id: runId, status: "running" }, "run.started");
    this.bus.emitNodePatch(runId, rootNodeId, { status: "queued" }, "node.progress");

    this.transitionPhase(runId, "BOOT", "Run started");
    this.bus.emitNodeProgress(runId, rootNodeId, "BOOT: Loading project and detecting repo state...");

    // Detect repo facts and docs inventory
    run.repoFacts = this.detectRepoFacts(run.repoPath);
    run.docsInventory = this.detectDocsInventory(run.repoPath);
    this.store.persistRun(run);

    this.bus.emitNodeProgress(runId, rootNodeId, `BOOT: Detected language=${run.repoFacts.language}, hasTests=${run.repoFacts.hasTests}, hasDocs=${run.repoFacts.hasDocs}`);

    // Collect harness health (simplified)
    const providers = this.providers.list();
    const results = await Promise.all(providers.map(async p => ({
      id: p.id,
      health: await p.healthCheck().catch(e => ({ ok: false, message: String(e) }))
    })));
    const art = this.store.createArtifact({
      runId,
      nodeId: rootNodeId,
      kind: "json",
      name: "harness.health.json",
      mimeType: "application/json",
      content: JSON.stringify({ checkedAt: nowIso(), providers: results }, null, 2),
    });
    this.bus.emitArtifact(runId, art);

    // Root orchestrator workspace
    const rootWs = await this.workspace.prepareWorkspace({ repoPath: run.repoPath, runId, nodeId: rootNodeId });
    this.bus.emitNodePatch(runId, rootNodeId, { workspacePath: rootWs }, "node.progress");

    if (!run.globalMode) {
      run.globalMode = "PLANNING";
      this.store.persistRun(run);
    }

    // Prepare Initial Context for Root Agent
    const initialContext: Record<string, unknown> = {
      repoFacts: run.repoFacts,
      docsInventory: run.docsInventory,
      missingRequiredDocs: run.docsInventory?.missingRequired ?? [],
      globalMode: run.globalMode,
    };

    const rootNode = run.nodes[rootNodeId];
    if (rootNode) {
      if (!rootNode.input) rootNode.input = {};
      // Helper check for object
      if (typeof rootNode.input === 'object' && rootNode.input) {
        Object.assign(rootNode.input, initialContext);
      }
      this.store.persistRun(run);
    }

    this.transitionPhase(runId, "EXECUTE", "Ready for graph execution");

    // Handoff to scheduler
    await this.scheduler.start(runId);
  }

  /**
   * Recover a run from disk (e.g. on server restart).
   * Restarts the scheduler loop without resetting phase/status.
   */
  async recoverRun(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) return;

    console.log(`[Orchestrator] Recovering run ${runId} in phase ${run.phase}`);

    // Ensure run is marked as running if it was active
    // If it was "queued" (from our cleanup), we should probably set it to "running" globally
    // so the UI knows it's active, OR just rely on scheduler picking up "queued" nodes?
    // The run.status itself should be "running" if the scheduler is active.
    if (run.status !== "running" && run.status !== "paused") {
      run.status = "running";
      this.store.persistRun(run);
      this.bus.emitRunPatch(runId, { id: runId, status: "running" }, "run.resumed");
    }

    // Start the scheduler loop
    // No await here? We want to start it in background usually? 
    // But start() is async and blocks until loop finishes.
    // So we should NOT await it if calling from a synchronous/startup context that iterates multiple runs.
    this.scheduler.start(runId).catch(e => {
      console.error(`[Orchestrator] Failed to recover run ${runId}`, e);
    });
  }

  // Shim for workflow dependencies
  private runProviderNode(node: NodeRecord, provider: ProviderAdapter, params: any, signal: AbortSignal): Promise<unknown> {
    // Workflows use this. We delegating to NodeExecutor's private runProviderTask via a cast for now.
    return (this.nodeExecutor as any).runProviderTask(node.runId, node, provider, params, signal);
  }
}
