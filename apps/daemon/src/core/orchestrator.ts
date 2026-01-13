import { randomUUID } from "node:crypto";
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

export interface OrchestratorConfig {
  roles: Record<string, string>;
  scheduler: { maxConcurrency: number };
  orchestration: { maxIterations: number; maxTurnsPerNode?: number };
  verification: { commands: string[] };
  workspace?: { cleanupOnDone?: boolean };
}

export interface CreateRunParams {
  prompt: string;
  repoPath: string;
  configSnapshot: Record<string, unknown>;
}

/**
 * Options for manual turn execution.
 */
export interface ManualTurnOptions {
  /** Optional context to attach (artifacts, files, summaries). */
  attachContext?: string[];
  /** Optional JSON schema for structured output. */
  expectedSchema?: string;
  /** Tool policy override for this turn only. */
  turnPolicy?: TurnPolicy;
  /** Max turns to run (usually 1 for manual). */
  maxTurns?: number;
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

  // active runs
  private controllers: Map<string, AbortController> = new Map();
  // pause signals
  private pauseSignals: Map<string, { resolve: () => void; promise: Promise<void> }> = new Map();
  // mode stop flags - set when switching to INTERACTIVE, prevents new turns
  private modeStopFlags: Map<string, boolean> = new Map();
  // turns currently in progress per run (for UI feedback)
  private turnsInProgress: Map<string, Set<string>> = new Map();

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
  }

  /** Get the ChatManager for external access (API endpoints). */
  getChatManager(): ChatManager {
    return this.chatManager;
  }

  isRunning(runId: string): boolean {
    return this.controllers.has(runId);
  }

  stopRun(runId: string): boolean {
    const c = this.controllers.get(runId);
    if (!c) return false;
    c.abort();
    // also resolve any pause to let it exit
    const pause = this.pauseSignals.get(runId);
    if (pause) {
      pause.resolve();
      this.pauseSignals.delete(runId);
    }
    return true;
  }

  pauseRun(runId: string): boolean {
    if (!this.controllers.has(runId)) return false;
    if (this.pauseSignals.has(runId)) return true; // already paused

    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => { resolve = r; });
    this.pauseSignals.set(runId, { resolve, promise });

    // We abort the current step execution to "interrupt" immediately.
    // The run loop will catch the abort, check if it's a pause, and then wait.
    const c = this.controllers.get(runId);
    if (c) c.abort(); 

    // Re-create controller for the resume phase, because the old one is now aborted.
    // But we need to keep the entry in the map so isRunning returns true.
    // The runLoop will need to handle this swap carefully.
    // Actually, simply aborting the controller will throw "AbortError" in the current step.
    // We catch that error, check if pauseSignals[runId] exists.
    // If so, we enter wait mode.
    // After wait, we need a fresh AbortController for the next steps.
    
    // NOTE: Swapping the controller mid-flight in runLoop is tricky. 
    // Instead of aborting immediately, we can let the current step finish if we want "safe" pause.
    // But user asked for "interrupt at anytime".
    // So we DO abort. The runLoop needs to be robust to this.
    
    this.bus.emitRunPatch(runId, { id: runId, status: "paused" }, "run.paused");
    return true;
  }

  resumeRun(runId: string, feedback?: string): boolean {
    const pause = this.pauseSignals.get(runId);
    if (!pause) return false;

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

    pause.resolve();
    this.pauseSignals.delete(runId);

    // We need to restore the AbortController because the previous one was likely aborted to trigger the pause.
    // The runLoop is responsible for creating a new one if it finds the old one aborted but the run is not stopped.

    this.bus.emitRunPatch(runId, { id: runId, status: "running" }, "run.resumed");
    return true;
  }

  /**
   * Interrupt the current execution and inject a chat message.
   * The message is stored, execution is paused, then immediately resumed with the message context.
   */
  interruptWithMessage(runId: string, content: string, nodeId?: string): boolean {
    if (!this.controllers.has(runId)) return false;

    // Store the message via ChatManager
    this.chatManager.sendMessage({
      runId,
      nodeId,
      content,
      interrupt: true,
    });

    // Pause the run
    this.pauseRun(runId);

    // Immediately resume (the message is now in the ChatManager's pending queue)
    // Use a small delay to allow the pause to propagate
    setTimeout(() => {
      if (this.pauseSignals.has(runId)) {
        this.resumeRun(runId);
      }
    }, 50);

    return true;
  }

  /**
   * Queue a message for the next iteration without interrupting.
   */
  queueMessage(runId: string, content: string, nodeId?: string): boolean {
    if (!this.store.getRun(runId)) return false;

    this.chatManager.queueMessage(runId, content, nodeId);
    return true;
  }

  /**
   * Get the interaction mode for a run or specific node.
   */
  getInteractionMode(runId: string, nodeId?: string): InteractionMode {
    return this.chatManager.getInteractionMode(runId, nodeId);
  }

  /**
   * Set the interaction mode for a run or specific node.
   */
  setInteractionMode(runId: string, mode: InteractionMode, nodeId?: string): boolean {
    if (!this.store.getRun(runId)) return false;
    this.chatManager.setInteractionMode(runId, nodeId, mode);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RUN MODE CONTROL (AUTO/INTERACTIVE)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the current run mode.
   */
  getRunMode(runId: string): RunMode | null {
    const run = this.store.getRun(runId);
    return run?.mode ?? null;
  }

  /**
   * Set the run mode (AUTO or INTERACTIVE).
   *
   * When switching to INTERACTIVE:
   * - Sets a stop flag so no new turns are scheduled
   * - Does NOT abort currently running turns (they complete)
   * - Emits run.mode.changed event
   *
   * When switching to AUTO:
   * - Clears the stop flag
   * - If run is active, orchestrator resumes scheduling
   * - Emits run.mode.changed event
   */
  setRunMode(runId: string, mode: RunMode, reason?: string): boolean {
    const run = this.store.getRun(runId);
    if (!run) return false;

    const previousMode = run.mode;
    if (previousMode === mode) return true; // Already in this mode

    // Update mode in store
    run.mode = mode;
    this.store.persistRun(run);

    // Handle mode-specific logic
    if (mode === "INTERACTIVE") {
      // Set stop flag - prevents new turns from starting
      this.modeStopFlags.set(runId, true);
    } else {
      // Clear stop flag - allows orchestrator to resume scheduling
      this.modeStopFlags.delete(runId);
    }

    // Count turns in progress for UI feedback
    const turnsSet = this.turnsInProgress.get(runId);
    const turnsCount = turnsSet?.size ?? 0;

    // Emit mode changed event
    this.bus.emitRunModeChanged(runId, mode, previousMode, reason ?? "user_request", turnsCount);

    return true;
  }

  /**
   * Check if scheduling should stop (INTERACTIVE mode or stop flag set).
   */
  private shouldStopScheduling(runId: string): boolean {
    const run = this.store.getRun(runId);
    if (!run) return true;
    return run.mode === "INTERACTIVE" || this.modeStopFlags.get(runId) === true;
  }

  /**
   * Get the control setting for a node (AUTO or MANUAL).
   */
  getNodeControl(runId: string, nodeId: string): NodeControl | null {
    const run = this.store.getRun(runId);
    if (!run) return null;
    const node = run.nodes[nodeId];
    if (!node) return null;
    return node.control ?? "AUTO";
  }

  /**
   * Set the control setting for a node.
   */
  setNodeControl(runId: string, nodeId: string, control: NodeControl): boolean {
    const run = this.store.getRun(runId);
    if (!run) return false;
    const node = run.nodes[nodeId];
    if (!node) return false;

    const previousControl = node.control ?? "AUTO";
    if (previousControl === control) return true;

    node.control = control;
    this.store.persistRun(run);

    this.bus.emitNodeControlChanged(runId, nodeId, control, previousControl);
    return true;
  }

  /**
   * Check if a node can be auto-scheduled.
   * Returns false if:
   * - Run is in INTERACTIVE mode (unless this is a manual trigger)
   * - Node control is MANUAL
   */
  private canAutoScheduleNode(runId: string, nodeId: string): boolean {
    const run = this.store.getRun(runId);
    if (!run) return false;

    // If run is in INTERACTIVE mode, no auto-scheduling
    if (run.mode === "INTERACTIVE") return false;

    // If node control is MANUAL, no auto-scheduling
    const node = run.nodes[nodeId];
    if (node?.control === "MANUAL") return false;

    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RUN PHASE TRANSITIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the current run phase.
   */
  getRunPhase(runId: string): RunPhase | null {
    const run = this.store.getRun(runId);
    return run?.phase ?? null;
  }

  /**
   * Transition to a new phase.
   */
  private transitionPhase(runId: string, newPhase: RunPhase, reason?: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;

    const previousPhase = run.phase;
    if (previousPhase === newPhase) return;

    run.phase = newPhase;
    this.store.persistRun(run);
    this.bus.emitRunPhaseChanged(runId, newPhase, previousPhase, reason);
  }

  /**
   * Check if docs iteration is needed (section 7.1).
   * Triggers DOCS_ITERATION if:
   * - repo has no code
   * - repo has only /docs
   * - required docs are missing
   */
  private shouldEnterDocsIteration(run: { repoPath: string; docsInventory?: DocsInventory; repoFacts?: RepoFacts }): boolean {
    const inventory = run.docsInventory;
    const facts = run.repoFacts;

    if (facts?.isEmptyRepo) return true;
    if (facts?.hasOnlyDocs) return true;
    if (!inventory) return false;

    // If missing required docs, enter docs iteration
    if (inventory.missingRequired.length > 0) {
      return true;
    }

    return false;
  }

  /**
   * Detect docs inventory during BOOT phase.
   */
  private detectDocsInventory(repoPath: string): DocsInventory {
    const docsDir = path.join(repoPath, "docs");
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
    };

    try {
      const entries = fs.readdirSync(repoPath);
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
      } else if (fs.existsSync(path.join(repoPath, "go.mod"))) {
        facts.language = "go";
        facts.languages = ["go"];
        facts.testCommands = ["go test ./..."];
        facts.buildCommands = ["go build ./..."];
      } else if (fs.existsSync(path.join(repoPath, "Cargo.toml"))) {
        facts.language = "rust";
        facts.languages = ["rust"];
        facts.testCommands = ["cargo test"];
        facts.buildCommands = ["cargo build"];
      } else if (fs.existsSync(path.join(repoPath, "requirements.txt")) || fs.existsSync(path.join(repoPath, "pyproject.toml"))) {
        facts.language = "python";
        facts.languages = ["python"];
        facts.testCommands = ["pytest"];
      }

      // Detect git branch
      try {
        const gitHead = fs.readFileSync(path.join(repoPath, ".git", "HEAD"), "utf-8").trim();
        if (gitHead.startsWith("ref: refs/heads/")) {
          facts.gitBranch = gitHead.replace("ref: refs/heads/", "");
        }
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }

    return facts;
  }

  /**
   * Detect provider harness availability and health during BOOT.
   */
  private async collectHarnessHealth(runId: string, rootNodeId: string): Promise<void> {
    const providers = this.providers.list();
    if (providers.length === 0) return;

    this.bus.emitNodeProgress(runId, rootNodeId, "BOOT: Checking harness availability...");

    const results: Array<{
      id: string;
      displayName: string;
      kind: string;
      capabilities: ProviderAdapter["capabilities"];
      authStatus: "unknown" | "unavailable";
      health: { ok: boolean; message?: string; details?: Record<string, unknown> };
    }> = [];

    for (const provider of providers) {
      let health: { ok: boolean; message?: string; details?: Record<string, unknown> };
      try {
        health = await provider.healthCheck();
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        health = { ok: false, message };
      }
      results.push({
        id: provider.id,
        displayName: provider.displayName,
        kind: provider.kind,
        capabilities: provider.capabilities,
        authStatus: health.ok ? "unknown" : "unavailable",
        health,
      });
    }

    const payload = {
      checkedAt: nowIso(),
      providers: results,
    };

    const art = this.store.createArtifact({
      runId,
      nodeId: rootNodeId,
      kind: "json",
      name: "harness.health.json",
      mimeType: "application/json",
      content: JSON.stringify(payload, null, 2),
    });
    this.bus.emitArtifact(runId, art);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOCS_ITERATION PHASE - Section 7
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build a docs iteration plan based on missing docs.
   */
  private buildDocsIterationPlan(run: { docsInventory?: DocsInventory; prompt: string }): DocsIterationPlan {
    const inventory = run.docsInventory;
    const missingDocs = inventory?.missingRequired ?? [];
    const tasks: DocsIterationPlan["docAgentTasks"] = [];

    // Map missing docs to doc agent tasks
    for (const doc of missingDocs) {
      const docLower = doc.toLowerCase();

      if (docLower.includes("architecture")) {
        tasks.push({
          id: "draft-architecture",
          role: "architecture-drafter",
          targetDoc: "docs/ARCHITECTURE.md",
          instructions: `Create an ARCHITECTURE.md document that describes the system architecture for the following project goal:\n\n${run.prompt}\n\nInclude sections for: Overview, Components, Data Flow, Key Decisions.`,
          deps: [],
        });
      } else if (docLower.includes("overview")) {
        tasks.push({
          id: "draft-overview",
          role: "ux-spec-drafter",
          targetDoc: "docs/OVERVIEW.md",
          instructions: `Create an OVERVIEW.md document that provides a high-level project overview for:\n\n${run.prompt}\n\nInclude sections for: Purpose, Scope, Key Features, Getting Started.`,
          deps: [],
        });
      } else if (docLower.includes("plan")) {
        tasks.push({
          id: "draft-plan",
          role: "harness-integration-drafter",
          targetDoc: "docs/PLAN.md",
          instructions: `Create a PLAN.md document with the implementation plan for:\n\n${run.prompt}\n\nInclude sections for: Goals, Milestones, Tasks, Timeline (phases not dates).`,
          deps: ["draft-architecture"],
        });
      } else if (docLower.includes("acceptance")) {
        tasks.push({
          id: "draft-acceptance",
          role: "security-permissions-drafter",
          targetDoc: "docs/ACCEPTANCE.md",
          instructions: `Create an ACCEPTANCE.md document with acceptance criteria for:\n\n${run.prompt}\n\nInclude sections for: Success Criteria, Verification Steps, Test Requirements.`,
          deps: ["draft-plan"],
        });
      }
    }

    return { missingDocs, docAgentTasks: tasks };
  }

  /**
   * Run the DOCS_ITERATION phase - spawns doc agents to generate missing docs.
   */
  private async runDocsIterationPhase(
    runId: string,
    rootNodeId: string,
    getSignal: () => AbortSignal
  ): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) return;

    this.bus.emitNodeProgress(runId, rootNodeId, "DOCS_ITERATION: Generating missing documentation...");

    // 1. Build docs iteration plan
    const docsIterationPlan = this.buildDocsIterationPlan(run);

    if (docsIterationPlan.docAgentTasks.length === 0) {
      this.bus.emitNodeProgress(runId, rootNodeId, "DOCS_ITERATION: No doc tasks needed.");
      return;
    }

    // 2. Create doc nodes for each task
    const docNodes: Array<{ task: DocsIterationPlan["docAgentTasks"][0]; node: NodeRecord }> = [];

    for (const task of docsIterationPlan.docAgentTasks) {
      const providerId = this.cfg.roles[task.role] ?? this.cfg.roles["planner"] ?? "mock";
      const node = this.createTaskNode({
        runId,
        parentNodeId: rootNodeId,
        label: `Doc (${task.role}): ${path.basename(task.targetDoc)}`,
        role: "implementer", // Use implementer role with doc-specific prompt
        providerId,
      });
      docNodes.push({ task, node });
      this.createEdge(runId, rootNodeId, node.id, "handoff", `draft ${path.basename(task.targetDoc)}`);
    }

    // 3. Create dependency edges between doc nodes
    const byTaskId = new Map<string, string>();
    for (const dn of docNodes) {
      byTaskId.set(dn.task.id, dn.node.id);
    }
    for (const dn of docNodes) {
      for (const dep of dn.task.deps) {
        const depNodeId = byTaskId.get(dep);
        if (depNodeId) {
          this.createEdge(runId, depNodeId, dn.node.id, "dependency", "depends on");
        }
      }
    }

    // 4. Execute doc drafts with DAG scheduling (similar to EXECUTE phase)
    const semaphore = new Semaphore(this.cfg.scheduler.maxConcurrency);
    const completed = new Set<string>();
    const running = new Map<string, Promise<void>>();

    const canRun = (dn: { task: DocsIterationPlan["docAgentTasks"][0]; node: NodeRecord }) => {
      for (const dep of dn.task.deps) {
        const depNodeId = byTaskId.get(dep);
        if (depNodeId && !completed.has(depNodeId)) return false;
      }
      return true;
    };

    const startDocTask = async (dn: { task: DocsIterationPlan["docAgentTasks"][0]; node: NodeRecord }) => {
      const release = await semaphore.acquire();
      try {
        await this.checkPause(runId);
        if (this.shouldStopScheduling(runId)) {
          throw new Error("MODE_INTERACTIVE");
        }

        const provider = this.providers.get(dn.node.providerId ?? "mock") ?? this.roleProvider("planner");
        await this.runProviderNode(dn.node, provider, {
          prompt: this.buildDocDraftPrompt(dn.task),
        }, getSignal());
        this.createEdge(runId, dn.node.id, rootNodeId, "report", "doc draft");
      } finally {
        release();
        completed.add(dn.node.id);
      }
    };

    // Main scheduling loop for doc tasks
    while (completed.size < docNodes.length) {
      if (getSignal().aborted) {
        if (!this.pauseSignals.has(runId)) throw new Error("Run aborted");
        throw new Error("PAUSED_INTERRUPT");
      }

      // Launch ready doc tasks
      for (const dn of docNodes) {
        if (completed.has(dn.node.id)) continue;
        if (running.has(dn.node.id)) continue;
        if (!canRun(dn)) continue;
        const p = startDocTask(dn).catch((e) => {
          if (e.message === "PAUSED_INTERRUPT" || e.message === "aborted" || e.message === "MODE_INTERACTIVE") throw e;
          this.bus.emitNodePatch(runId, dn.node.id, {
            status: "failed",
            completedAt: nowIso(),
            error: { message: e?.message ?? String(e), stack: e?.stack },
          }, "node.failed");
        });
        running.set(dn.node.id, p);
      }

      if (running.size === 0) {
        this.bus.emitNodeProgress(runId, rootNodeId, "DOCS_ITERATION: Deadlock in doc scheduling.");
        break;
      }

      try {
        await Promise.race([...running.values()]);
      } catch (e: unknown) {
        const errMessage = e instanceof Error ? e.message : String(e);
        if (errMessage === "PAUSED_INTERRUPT" || errMessage === "aborted" || errMessage === "MODE_INTERACTIVE") throw e;
      }

      for (const [nodeId] of [...running.entries()]) {
        if (completed.has(nodeId)) running.delete(nodeId);
      }
    }

    // 5. Run doc review gate
    this.bus.emitNodeProgress(runId, rootNodeId, "DOCS_ITERATION: Reviewing generated documentation...");

    const reviewNode = this.createTaskNode({
      runId,
      parentNodeId: rootNodeId,
      label: "Doc Review",
      role: "reviewer",
      providerId: this.cfg.roles["reviewer"] ?? this.cfg.roles["planner"] ?? "mock",
    });
    this.createEdge(runId, rootNodeId, reviewNode.id, "gate", "doc review");

    await this.runProviderNode(reviewNode, this.roleProvider("reviewer"), {
      prompt: this.buildDocReviewPrompt(run),
    }, getSignal());
    this.createEdge(runId, reviewNode.id, rootNodeId, "report", "doc review result");

    // Update docs inventory after generation
    run.docsInventory = this.detectDocsInventory(run.repoPath);
    this.store.persistRun(run);

    this.bus.emitNodeProgress(runId, rootNodeId, "DOCS_ITERATION: Documentation phase complete.");
  }

  /**
   * Build prompt for doc drafting agent.
   */
  private buildDocDraftPrompt(task: DocsIterationPlan["docAgentTasks"][0]): string {
    return [
      "You are a documentation agent inside vuhlp code.",
      "",
      `Role: ${task.role}`,
      "",
      `Your task: Create the file ${task.targetDoc}`,
      "",
      "Instructions:",
      task.instructions,
      "",
      "Requirements:",
      "- Write clear, concise markdown documentation.",
      "- Use proper markdown formatting with headers, lists, and code blocks where appropriate.",
      "- Focus on practical, actionable content.",
      "- Save the file to the specified path.",
    ].join("\n");
  }

  /**
   * Build prompt for doc review agent.
   */
  private buildDocReviewPrompt(run: { prompt: string; repoPath: string }): string {
    return [
      "You are a documentation reviewer agent inside vuhlp code.",
      "",
      "Review all generated documentation for consistency, completeness, and alignment with the project goals.",
      "",
      `Project goal: ${run.prompt}`,
      `Repo path: ${run.repoPath}`,
      "",
      "Check for:",
      "- Contradictions between documents",
      "- Missing critical information",
      "- Unclear or ambiguous sections",
      "- Alignment with project goals",
      "",
      "Return JSON with fields: approved (boolean), contradictions (array of {doc, issue}), suggestions (array).",
    ].join("\n");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOCS_SYNC PHASE - Section 2.1
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Run the DOCS_SYNC phase - updates docs to match implementation reality.
   */
  private async runDocsSyncPhase(
    runId: string,
    rootNodeId: string,
    getSignal: () => AbortSignal
  ): Promise<DocsSyncResult> {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, hasChanges: false, summary: "" };

    this.transitionPhase(runId, "DOCS_SYNC", "Syncing documentation with implementation");
    this.bus.emitNodeProgress(runId, rootNodeId, "DOCS_SYNC: Updating documentation to match implementation...");

    // 1. Collect changes from the run
    const changesSummary = this.collectChangesSummary(runId);

    if (!changesSummary.hasChanges) {
      this.bus.emitNodeProgress(runId, rootNodeId, "DOCS_SYNC: No significant changes to document.");
      run.docsInventory = this.detectDocsInventory(run.repoPath);
      this.store.persistRun(run);
      return { ok: true, hasChanges: false, summary: "" };
    }

    // 2. Create doc update node
    const docUpdateNode = this.createTaskNode({
      runId,
      parentNodeId: rootNodeId,
      label: "Update Docs",
      role: "implementer",
      providerId: this.cfg.roles["planner"] ?? "mock",
    });
    this.createEdge(runId, rootNodeId, docUpdateNode.id, "handoff", "doc update");

    await this.runProviderNode(docUpdateNode, this.roleProvider("planner"), {
      prompt: this.buildDocsSyncPrompt(run, changesSummary),
    }, getSignal());
    this.createEdge(runId, docUpdateNode.id, rootNodeId, "report", "doc update result");

    // 3. Generate changelog entry
    const changelogNode = this.createTaskNode({
      runId,
      parentNodeId: rootNodeId,
      label: "Update Changelog",
      role: "implementer",
      providerId: this.cfg.roles["planner"] ?? "mock",
    });
    this.createEdge(runId, rootNodeId, changelogNode.id, "handoff", "changelog");

    await this.runProviderNode(changelogNode, this.roleProvider("planner"), {
      prompt: this.buildChangelogPrompt(run, changesSummary),
    }, getSignal());
    this.createEdge(runId, changelogNode.id, rootNodeId, "report", "changelog result");

    // 4. Final doc review
    const finalReviewNode = this.createTaskNode({
      runId,
      parentNodeId: rootNodeId,
      label: "Final Doc Review",
      role: "reviewer",
      providerId: this.cfg.roles["reviewer"] ?? this.cfg.roles["planner"] ?? "mock",
    });
    this.createEdge(runId, rootNodeId, finalReviewNode.id, "gate", "final review");

    await this.runProviderNode(finalReviewNode, this.roleProvider("reviewer"), {
      prompt: this.buildFinalDocReviewPrompt(run),
    }, getSignal());
    this.createEdge(runId, finalReviewNode.id, rootNodeId, "report", "final review result");

    this.bus.emitNodeProgress(runId, rootNodeId, "DOCS_SYNC: Documentation sync complete.");

    run.docsInventory = this.detectDocsInventory(run.repoPath);
    this.store.persistRun(run);

    const summaryPayload = {
      hasChanges: changesSummary.hasChanges,
      filesChanged: changesSummary.filesChanged,
      summary: changesSummary.summary,
    };
    const summaryArtifact = this.store.createArtifact({
      runId,
      nodeId: rootNodeId,
      kind: "json",
      name: "docs.sync.summary.json",
      mimeType: "application/json",
      content: JSON.stringify(summaryPayload, null, 2),
    });
    this.bus.emitArtifact(runId, summaryArtifact);

    return {
      ok: true,
      hasChanges: true,
      summary: changesSummary.summary,
    };
  }

  /**
   * Collect a summary of changes made during the run.
   */
  private collectChangesSummary(runId: string): { hasChanges: boolean; filesChanged: string[]; summary: string } {
    const run = this.store.getRun(runId);
    if (!run) return { hasChanges: false, filesChanged: [], summary: "" };

    const filesChanged: string[] = [];
    let summary = "";

    // Look for git diff artifacts
    const diffArtifacts = Object.values(run.artifacts)
      .filter((a) => a.kind === "diff" || a.name.includes("git.diff"))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    for (const art of diffArtifacts) {
      try {
        const content = fs.readFileSync(art.path, "utf-8");
        if (content.trim()) {
          summary += `\n\n## Changes from ${art.name}:\n${content.slice(0, 2000)}`;
          // Extract file names from diff
          const fileMatches = content.match(/^(?:diff --git a\/|[-+]{3} [ab]\/)(.+)$/gm);
          if (fileMatches) {
            for (const match of fileMatches) {
              const file = match.replace(/^(?:diff --git a\/|[-+]{3} [ab]\/)/, "").trim();
              if (!filesChanged.includes(file)) filesChanged.push(file);
            }
          }
        }
      } catch {
        // ignore
      }
    }

    return {
      hasChanges: filesChanged.length > 0 || summary.length > 0,
      filesChanged,
      summary: summary.trim(),
    };
  }

  /**
   * Build prompt for docs sync agent.
   */
  private buildDocsSyncPrompt(run: { prompt: string; repoPath: string }, changes: { filesChanged: string[]; summary: string }): string {
    return [
      "You are a documentation sync agent inside vuhlp code.",
      "",
      "Update the project documentation to reflect the changes made in this implementation run.",
      "",
      `Original request: ${run.prompt}`,
      `Repo path: ${run.repoPath}`,
      "",
      "Files changed:",
      changes.filesChanged.map((f) => `- ${f}`).join("\n"),
      "",
      "Changes summary:",
      changes.summary.slice(0, 3000),
      "",
      "Tasks:",
      "1. Update docs/ARCHITECTURE.md if architecture changed",
      "2. Update docs/DECISIONS.md with any new decisions made",
      "3. Update other relevant documentation",
      "",
      "Only update docs if there are meaningful changes to document.",
      "Do not create new files unless necessary.",
    ].join("\n");
  }

  /**
   * Build prompt for changelog update.
   */
  private buildChangelogPrompt(run: { prompt: string }, changes: { filesChanged: string[]; summary: string }): string {
    return [
      "You are a changelog agent inside vuhlp code.",
      "",
      "Append an entry to docs/CHANGELOG.md (create if it doesn't exist) for this implementation run.",
      "",
      `Implementation: ${run.prompt}`,
      "",
      "Files changed:",
      changes.filesChanged.slice(0, 20).map((f) => `- ${f}`).join("\n"),
      "",
      "Format:",
      "```markdown",
      "## [Date] - Brief Description",
      "",
      "### Added/Changed/Fixed",
      "- Description of changes",
      "```",
      "",
      "Keep the entry concise but informative.",
    ].join("\n");
  }

  /**
   * Build prompt for final doc review.
   */
  private buildFinalDocReviewPrompt(run: { prompt: string; repoPath: string }): string {
    return [
      "You are a final documentation reviewer inside vuhlp code.",
      "",
      "Perform a final review of all documentation to ensure:",
      "1. Consistency between implementation and documentation",
      "2. No contradictions between different docs",
      "3. All major changes are documented",
      "",
      `Project goal: ${run.prompt}`,
      `Repo path: ${run.repoPath}`,
      "",
      "Read the docs directory and verify alignment.",
      "",
      "Return JSON: { reviewed: true, issues: [], notes: string }",
    ].join("\n");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MANUAL TURN CONTROL (for INTERACTIVE mode)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Manually trigger a turn for a node (in INTERACTIVE mode or for MANUAL nodes).
   */
  async manualTurn(
    runId: string,
    nodeId: string,
    userMessage: string,
    options?: ManualTurnOptions
  ): Promise<{ success: boolean; error?: string; output?: unknown }> {
    const run = this.store.getRun(runId);
    if (!run) return { success: false, error: "Run not found" };

    const node = run.nodes[nodeId];
    if (!node) return { success: false, error: "Node not found" };

    // Get or create workspace for this node
    const wsPath = node.workspacePath ?? await this.workspace.prepareWorkspace({
      repoPath: run.repoPath,
      runId,
      nodeId,
    });

    // Get provider for this node
    const providerId = node.providerId ?? this.cfg.roles[node.role ?? "implementer"] ?? "mock";
    const provider = this.providers.get(providerId);
    if (!provider) return { success: false, error: `Provider not found: ${providerId}` };

    // Track turn
    const turnId = randomUUID();
    const turnNumber = (node.turnCount ?? 0) + 1;

    // Register turn in progress
    let turnsSet = this.turnsInProgress.get(runId);
    if (!turnsSet) {
      turnsSet = new Set();
      this.turnsInProgress.set(runId, turnsSet);
    }
    turnsSet.add(turnId);

    // Emit turn started
    this.bus.emitTurnStarted(runId, nodeId, turnId, turnNumber, true, userMessage);

    // Update node status
    this.bus.emitNodePatch(runId, nodeId, {
      status: "running",
      startedAt: node.startedAt ?? nowIso(),
    }, "node.started");

    const startTime = Date.now();

    try {
      // Create abort controller for this turn
      const controller = new AbortController();

      // Build the prompt
      const prompt = this.buildManualTurnPrompt(runId, nodeId, userMessage, options);

      // Run the provider
      let finalOutput: unknown = undefined;
      let finalContent: string | undefined;
      let tokenCount: number | undefined;

      const iter = provider.runTask({
        runId,
        nodeId,
        role: (node.role ?? "implementer"),
        prompt,
        workspacePath: wsPath,
        outputSchemaJson: options?.expectedSchema,
        sessionId: node.providerSessionId,
      }, controller.signal);

      for await (const ev of iter) {
        switch (ev.type) {
          case "progress":
            this.bus.emitNodeProgress(runId, nodeId, ev.message, ev.raw);
            break;
          case "message.delta":
            this.bus.emitMessageDelta(runId, nodeId, ev.delta, ev.index);
            break;
          case "message.final":
            finalContent = ev.content;
            tokenCount = ev.tokenCount;
            this.bus.emitMessageFinal(runId, nodeId, ev.content, ev.tokenCount);
            break;
          case "session":
            // Update session ID for continuity
            node.providerSessionId = ev.sessionId;
            break;
          case "final":
            finalOutput = ev.output ?? finalOutput;
            break;
          case "console":
            this.bus.emitConsoleChunk(runId, nodeId, ev.stream, ev.data);
            break;
        }
      }

      const durationMs = Date.now() - startTime;

      // Update node
      this.bus.emitNodePatch(runId, nodeId, {
        output: finalOutput,
        turnCount: turnNumber,
        lastTurnId: turnId,
      }, "node.progress");

      // Emit turn completed
      this.bus.emitTurnCompleted(runId, nodeId, turnId, turnNumber, true, {
        content: finalContent,
        tokenCount,
        durationMs,
      });

      // Persist session
      this.store.persistRun(run);

      return { success: true, output: finalOutput };

    } catch (e: unknown) {
      const errMessage = e instanceof Error ? e.message : String(e);
      const errStack = e instanceof Error ? e.stack : undefined;
      const durationMs = Date.now() - startTime;

      this.bus.emitTurnCompleted(runId, nodeId, turnId, turnNumber, true, undefined, {
        message: errMessage,
        stack: errStack,
      });

      return { success: false, error: errMessage };
    } finally {
      // Remove from turns in progress
      turnsSet.delete(turnId);
      if (turnsSet.size === 0) {
        this.turnsInProgress.delete(runId);
      }
    }
  }

  /**
   * Send a "continue" instruction to a node (useful when agent paused itself).
   */
  async manualContinue(
    runId: string,
    nodeId: string
  ): Promise<{ success: boolean; error?: string; output?: unknown }> {
    return this.manualTurn(
      runId,
      nodeId,
      "Continue from where you left off. Do not ask questions; make best assumptions.",
      { maxTurns: 1 }
    );
  }

  /**
   * Manually run verification.
   */
  async manualVerify(
    runId: string,
    profileId?: string
  ): Promise<{ success: boolean; ok?: boolean; error?: string }> {
    const run = this.store.getRun(runId);
    if (!run) return { success: false, error: "Run not found" };

    const commands = (this.cfg.verification.commands ?? []).filter((c) => String(c).trim().length);
    if (!commands.length) {
      return { success: true, ok: true };
    }

    // Create verification node
    const verifyNode = this.createVerificationNode(runId, run.rootOrchestratorNodeId, run.repoPath);
    this.createEdge(runId, run.rootOrchestratorNodeId, verifyNode.id, "gate", "manual-verify");

    const controller = new AbortController();
    const result = await this.runVerificationNode(verifyNode, controller.signal);

    return { success: true, ok: result.ok };
  }

  /**
   * Create a new node manually.
   */
  createManualNode(params: {
    runId: string;
    parentNodeId: string;
    providerId: string;
    role?: RoleId;
    label?: string;
    control?: NodeControl;
  }): NodeRecord | null {
    const run = this.store.getRun(params.runId);
    if (!run) return null;

    const node = this.createTaskNode({
      runId: params.runId,
      parentNodeId: params.parentNodeId,
      label: params.label ?? "Manual Node",
      role: params.role ?? "implementer",
      providerId: params.providerId,
    });

    if (params.control) {
      node.control = params.control;
    }

    this.store.persistRun(run);
    return node;
  }

  private buildManualTurnPrompt(
    runId: string,
    nodeId: string,
    userMessage: string,
    options?: ManualTurnOptions
  ): string {
    const run = this.store.getRun(runId);
    const node = run?.nodes[nodeId];

    let prompt = userMessage;

    // Add context if specified
    if (options?.attachContext?.length) {
      prompt += "\n\n--- ATTACHED CONTEXT ---\n";
      for (const ctx of options.attachContext) {
        prompt += `\n${ctx}\n`;
      }
      prompt += "--- END CONTEXT ---\n";
    }

    // Add any pending chat messages
    const chatSection = this.chatManager.buildChatPromptSection(runId, nodeId);
    if (chatSection) {
      prompt += chatSection;
    }

    return prompt;
  }

  // ═══════════════════════════════════════════════════════════════════════════

  async startRun(runId: string): Promise<void> {
    if (this.controllers.has(runId)) return;
    const controller = new AbortController();
    this.controllers.set(runId, controller);

    try {
      await this.runLoop(runId);
    } finally {
      this.controllers.delete(runId);
      this.pauseSignals.delete(runId);
    }
  }

  private roleProvider(role: RoleId): ProviderAdapter {
    const providerId = this.cfg.roles[role] ?? "mock";
    const p = this.providers.get(providerId);
    if (!p) throw new Error(`Provider not configured: ${providerId} (role=${role})`);
    return p;
  }

  private async checkPause(runId: string): Promise<void> {
    const pause = this.pauseSignals.get(runId);
    if (pause) {
      await pause.promise;
      // After resume, we need to ensure we have a valid (non-aborted) controller for the next steps.
      const oldCtrl = this.controllers.get(runId);
      if (oldCtrl && oldCtrl.signal.aborted) {
        this.controllers.set(runId, new AbortController());
      }
    }
  }

  /**
   * Wait for the first user message in the chat (for empty sessions).
   */
  private async waitForFirstUserMessage(runId: string): Promise<string> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        // Check for stop/abort
        const controller = this.controllers.get(runId);
        if (controller?.signal.aborted) {
          clearInterval(checkInterval);
          // If aborted, we can't really return a prompt, but the run loop will catch the abort signal
          // and exit. We just resolve with empty string to break the wait.
          resolve("");
          return;
        }

        // Check for messages
        const messages = this.chatManager.getMessages(runId);
        const userMsg = messages.find(m => m.role === "user");
        if (userMsg) {
          clearInterval(checkInterval);
          resolve(userMsg.content);
        }
      }, 500);
    });
  }

  /**
   * Wait for run mode to switch back to AUTO if currently INTERACTIVE.
   * This is used by the orchestrator loop to pause scheduling when in INTERACTIVE mode.
   */
  private async waitForAutoMode(runId: string): Promise<boolean> {
    const run = this.store.getRun(runId);
    if (!run) return false;

    // If already in AUTO mode, continue immediately
    if (run.mode === "AUTO" && !this.modeStopFlags.get(runId)) {
      return true;
    }

    // In INTERACTIVE mode - wait by polling
    // The orchestrator will check this periodically
    this.bus.emitNodeProgress(runId, run.rootOrchestratorNodeId, "Waiting for AUTO mode to resume scheduling...");

    // Poll every 500ms for mode change
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const currentRun = this.store.getRun(runId);
        if (!currentRun) {
          clearInterval(checkInterval);
          resolve(false);
          return;
        }

        // Check if stopped
        const controller = this.controllers.get(runId);
        if (controller?.signal.aborted) {
          clearInterval(checkInterval);
          resolve(false);
          return;
        }

        // Check if mode switched to AUTO
        if (currentRun.mode === "AUTO" && !this.modeStopFlags.get(runId)) {
          clearInterval(checkInterval);
          resolve(true);
        }
      }, 500);
    });
  }

  private async runLoop(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const rootNodeId = run.rootOrchestratorNodeId;

    this.bus.emitRunPatch(runId, { id: runId, status: "running" }, "run.started");
    this.bus.emitNodePatch(runId, rootNodeId, { status: "running", startedAt: nowIso() }, "node.started");

    // ═══════════════════════════════════════════════════════════════════════════
    // BOOT PHASE - Section 2.1
    // ═══════════════════════════════════════════════════════════════════════════
    this.transitionPhase(runId, "BOOT", "Run started");
    this.bus.emitNodeProgress(runId, rootNodeId, "BOOT: Loading project and detecting repo state...");

    // Detect repo facts and docs inventory
    run.repoFacts = this.detectRepoFacts(run.repoPath);
    run.docsInventory = this.detectDocsInventory(run.repoPath);
    this.store.persistRun(run);

    this.bus.emitNodeProgress(runId, rootNodeId, `BOOT: Detected language=${run.repoFacts.language}, hasTests=${run.repoFacts.hasTests}, hasDocs=${run.repoFacts.hasDocs}`);

    await this.collectHarnessHealth(runId, rootNodeId);

    // Root orchestrator workspace (mostly used for verification).
    const rootWs = await this.workspace.prepareWorkspace({ repoPath: run.repoPath, runId, nodeId: rootNodeId });
    this.bus.emitNodePatch(runId, rootNodeId, { workspacePath: rootWs }, "node.progress");

    // Helper to get current signal (defined early for use in DOCS_ITERATION)
    const getSignal = () => {
      const c = this.controllers.get(runId);
      return c ? c.signal : new AbortController().signal; // fallback if missing
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // DOCS_ITERATION PHASE - Section 7 (conditional)
    // ═══════════════════════════════════════════════════════════════════════════
    if (this.shouldEnterDocsIteration(run)) {
      this.transitionPhase(runId, "DOCS_ITERATION", "Missing required documentation");
      await this.runDocsIterationPhase(runId, rootNodeId, getSignal);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SESSION INIT - Wait for user input if prompt is generic
    // ═══════════════════════════════════════════════════════════════════════════
    if (run.prompt === "(Session Started)") {
      this.bus.emitNodeProgress(runId, rootNodeId, "Waiting for user instructions...");
      const realPrompt = await this.waitForFirstUserMessage(runId);
      run.prompt = realPrompt;
      this.store.persistRun(run);
      this.bus.emitRunPatch(runId, { id: runId, prompt: realPrompt }, "run.updated");
      this.bus.emitNodeProgress(runId, rootNodeId, "Received instructions. Starting...");
    }

    let iteration = 0;
    let plan: TaskDagRecord | null = null;
    let lastFixContext = "";

    while (true) {
      // Check pause at top of loop
      await this.checkPause(runId);
      if (getSignal().aborted && !this.pauseSignals.has(runId)) break; // truly stopped

      // Check run mode - if INTERACTIVE, wait for AUTO to resume
      if (this.shouldStopScheduling(runId)) {
        const shouldContinue = await this.waitForAutoMode(runId);
        if (!shouldContinue) break; // Run was stopped while waiting
      }

      if (iteration >= run.maxIterations) {
        this.bus.emitNodeProgress(runId, rootNodeId, `Max iterations reached (${run.maxIterations}). Failing run.`);
        this.bus.emitRunPatch(runId, { id: runId, status: "failed" }, "run.failed");
        this.bus.emitNodePatch(runId, rootNodeId, { status: "failed", completedAt: nowIso() }, "node.failed");
        return;
      }

      try {
        // ═══════════════════════════════════════════════════════════════════════
        // INVESTIGATE PHASE - Section 2.1
        // ═══════════════════════════════════════════════════════════════════════
        if (iteration === 0) {
          this.transitionPhase(runId, "INVESTIGATE", "Starting investigation");
          await this.checkPause(runId);
          if (getSignal().aborted && !this.pauseSignals.has(runId)) break;

          this.bus.emitNodeProgress(runId, rootNodeId, "INVESTIGATE: Scanning repo and identifying verification commands...");

          const invNode = this.createTaskNode({
            runId,
            parentNodeId: rootNodeId,
            label: "Investigate",
            role: "investigator",
            providerId: this.cfg.roles["investigator"] ?? "mock",
          });
          this.createEdge(runId, rootNodeId, invNode.id, "handoff", "investigate");
          await this.runProviderNode(invNode, this.roleProvider("investigator"), {
            prompt: this.buildInvestigationPrompt(run.prompt, run.repoPath),
            outputSchemaName: "repo-brief",
          }, getSignal());
          this.createEdge(runId, invNode.id, rootNodeId, "report", "investigation report");
        }

        // ═══════════════════════════════════════════════════════════════════════
        // PLAN PHASE - Section 2.1
        // ═══════════════════════════════════════════════════════════════════════
        if (iteration === 0) {
          this.transitionPhase(runId, "PLAN", "Starting planning");
          await this.checkPause(runId);
          if (getSignal().aborted && !this.pauseSignals.has(runId)) break;

          this.bus.emitNodeProgress(runId, rootNodeId, "PLAN: Creating task DAG and acceptance criteria...");

          const planNode = this.createTaskNode({
            runId,
            parentNodeId: rootNodeId,
            label: "Plan",
            role: "planner",
            providerId: this.cfg.roles["planner"] ?? "mock",
          });
          this.createEdge(runId, rootNodeId, planNode.id, "handoff", "plan");

          const userFeedback = this.collectUserFeedback(runId);
          const planOutput = await this.runProviderNode(planNode, this.roleProvider("planner"), {
            prompt: this.buildPlanningPrompt(run.prompt, lastFixContext, userFeedback),
            outputSchemaName: "plan",
          }, getSignal());
          this.createEdge(runId, planNode.id, rootNodeId, "report", "plan report");

          const normalizedPlan = this.normalizePlanOutput(planOutput, run.prompt);
          plan = normalizedPlan.taskDag;

          const runForPlan = this.store.getRun(runId);
          if (runForPlan) {
            runForPlan.taskDag = plan;
            runForPlan.acceptanceCriteria = normalizedPlan.acceptanceCriteria;
            this.store.persistRun(runForPlan);
          }

          if (normalizedPlan.usedFallback) {
            this.bus.emitNodeProgress(runId, rootNodeId, "PLAN: Falling back to minimal plan due to invalid output.");
          }

          this.writePlanningArtifacts(run.repoPath, plan, normalizedPlan.acceptanceCriteria);
          const runAfterDocs = this.store.getRun(runId);
          if (runAfterDocs) {
            runAfterDocs.docsInventory = this.detectDocsInventory(runAfterDocs.repoPath);
            this.store.persistRun(runAfterDocs);
          }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // EXECUTE PHASE - Section 2.1
        // ═══════════════════════════════════════════════════════════════════════
        this.transitionPhase(runId, "EXECUTE", "Starting execution");
        this.bus.emitNodeProgress(runId, rootNodeId, "EXECUTE: Scheduling and executing tasks...");

        // IMPLEMENT steps
        const steps = this.extractSteps(plan, run.prompt, iteration, lastFixContext);
        const semaphore = new Semaphore(this.cfg.scheduler.maxConcurrency);

        // Map stepId -> nodeId
        const stepNodes: Array<{ step: TaskStep; node: NodeRecord }> = [];
        for (const step of steps) {
          const providerId = this.pickProviderForStep(step);
          const node = this.createTaskNode({
            runId,
            parentNodeId: rootNodeId,
            label: step.title ?? step.id ?? "Step",
            role: "implementer",
            providerId,
            input: { step },
          });
          stepNodes.push({ step, node });
          this.createEdge(runId, rootNodeId, node.id, "handoff", "step");
        }

        // dependencies edges
        const byStepId = new Map<string, string>();
        for (const sn of stepNodes) {
          if (sn.step.id) byStepId.set(String(sn.step.id), sn.node.id);
        }
        for (const sn of stepNodes) {
          const deps: string[] = Array.isArray(sn.step.deps) ? sn.step.deps : [];
          for (const dep of deps) {
            const depNodeId = byStepId.get(dep);
            if (depNodeId) this.createEdge(runId, depNodeId, sn.node.id, "dependency", "depends on");
          }
        }

        this.updateTaskDagNodeLinks(runId, stepNodes);

        // Execute DAG-ish
        const completed = new Set<string>();
        const running = new Map<string, Promise<void>>();
        let stepsOk = true;

        const startStep = async (sn: { step: TaskStep; node: NodeRecord }) => {
          const release = await semaphore.acquire();
          try {
            await this.checkPause(runId); // check before starting

            const provider = this.providers.get(sn.node.providerId ?? "mock") ?? this.roleProvider("implementer");
            const userFeedback = this.collectUserFeedback(runId);
            const stepPrompt = this.buildStepPrompt(runId, sn.node.id, run.prompt, sn.step, iteration, lastFixContext, userFeedback);

            // Check if we should queue the prompt in INTERACTIVE mode (Section 3.4)
            const currentRun = this.store.getRun(runId);
            if (currentRun?.mode === "INTERACTIVE") {
              // Build context pack for the queued prompt
              const contextPack = this.contextPackBuilder.buildForStep({
                run: currentRun,
                step: sn.step,
                repoPath: currentRun.repoPath,
              });

              // Queue the prompt for user review
              const pendingPrompt = this.promptQueue.addOrchestratorPrompt({
                runId,
                targetNodeId: sn.node.id,
                content: stepPrompt,
                contextPack,
              });

              // Set node to blocked_manual_input
              this.bus.emitNodePatch(runId, sn.node.id, {
                status: "blocked_manual_input",
              }, "node.progress");

              this.bus.emitNodeProgress(
                runId,
                sn.node.id,
                `INTERACTIVE: Prompt queued for review (${pendingPrompt.id.slice(0, 8)})`
              );

              // Wait for mode switch back to AUTO or manual trigger
              const shouldContinue = await this.waitForAutoMode(runId);
              if (!shouldContinue) throw new Error("Run aborted");

              // Re-check if prompt was sent (by user)
              const prompt = this.promptQueue.getPrompt(pendingPrompt.id);
              if (prompt?.status !== "sent") {
                // Prompt was cancelled or still pending - skip this step
                this.bus.emitNodePatch(runId, sn.node.id, {
                  status: "skipped",
                  completedAt: nowIso(),
                  summary: "Prompt was cancelled by user",
                }, "node.completed");
                return;
              }
            }

            await this.runProviderNode(sn.node, provider, { prompt: stepPrompt }, getSignal());
            this.createEdge(runId, sn.node.id, rootNodeId, "report", "step report");
          } finally {
            release();
            completed.add(sn.node.id);
          }
        };

        const canRun = (sn: { step: TaskStep; node: NodeRecord }) => {
          const deps: string[] = Array.isArray(sn.step.deps) ? sn.step.deps : [];
          for (const dep of deps) {
            const depNodeId = byStepId.get(dep);
            if (depNodeId && !completed.has(depNodeId)) return false;
          }
          return true;
        };

        // Check if node control allows auto-scheduling
        const canAutoSchedule = (sn: { step: TaskStep; node: NodeRecord }) => {
          // Check node-level control override
          if (sn.node.control === "MANUAL") {
            // Set to blocked_manual_input
            this.bus.emitNodePatch(runId, sn.node.id, {
              status: "blocked_manual_input",
            }, "node.progress");
            return false;
          }
          return true;
        };

        // Main scheduling loop
        while (completed.size < stepNodes.length) {
          if (getSignal().aborted) {
             // If aborted but NOT paused, throw. If paused, we handle it in catch.
             if (!this.pauseSignals.has(runId)) throw new Error("Run aborted");
             // If paused, we should throw to exit the Promise.race, catch, wait, and loop.
             throw new Error("PAUSED_INTERRUPT");
          }

          // Check for INTERACTIVE mode - wait if needed
          if (this.shouldStopScheduling(runId)) {
            const shouldContinue = await this.waitForAutoMode(runId);
            if (!shouldContinue) throw new Error("Run aborted");
          }

          // launch ready steps
          for (const sn of stepNodes) {
            if (completed.has(sn.node.id)) continue;
            if (running.has(sn.node.id)) continue;
            if (!canRun(sn)) continue;
            if (!canAutoSchedule(sn)) continue; // Skip MANUAL nodes
            const p = startStep(sn).catch((e) => {
              if (e.message === "PAUSED_INTERRUPT" || e.message === "aborted" || e.message === "MODE_INTERACTIVE") throw e; // bubble up
              // mark node failed
              this.bus.emitNodePatch(runId, sn.node.id, {
                status: "failed",
                completedAt: nowIso(),
                error: { message: e?.message ?? String(e), stack: e?.stack },
              }, "node.failed");
            });
            running.set(sn.node.id, p);
          }

          // await something to finish
          if (running.size === 0) {
            // Deadlock: deps cycle or missing dep
            this.bus.emitNodeProgress(runId, rootNodeId, "Deadlock in step scheduling. Check plan deps.");
            break;
          }
          
          try {
            await Promise.race([...running.values()]);
          } catch (e: unknown) {
             const errMessage = e instanceof Error ? e.message : String(e);
             if (errMessage === "PAUSED_INTERRUPT" || errMessage === "aborted" || errMessage === "MODE_INTERACTIVE") throw e;
             // otherwise ignore step failure here, handled in catch
          }
          
          // cleanup resolved
          for (const [nodeId, p] of [...running.entries()]) {
            if (completed.has(nodeId)) running.delete(nodeId);
          }
        }

        this.updateTaskDagStatuses(runId);
        stepsOk = this.allStepsCompleted(runId, stepNodes);

        // REVIEW (optional) - minimal in v0
        const reviewerId = this.cfg.roles["reviewer"];
        if (reviewerId) {
          await this.checkPause(runId);
          const reviewNode = this.createTaskNode({
            runId,
            parentNodeId: rootNodeId,
            label: "Review",
            role: "reviewer",
            providerId: reviewerId,
          });
          this.createEdge(runId, rootNodeId, reviewNode.id, "handoff", "review");
          await this.runProviderNode(reviewNode, this.roleProvider("reviewer"), {
            prompt: this.buildReviewPrompt(run.prompt),
          }, getSignal());
          this.createEdge(runId, reviewNode.id, rootNodeId, "report", "review report");
        }

        // ═══════════════════════════════════════════════════════════════════════
        // VERIFY PHASE - Section 2.1
        // ═══════════════════════════════════════════════════════════════════════
        this.transitionPhase(runId, "VERIFY", "Starting verification");
        this.bus.emitNodeProgress(runId, rootNodeId, "VERIFY: Running checks, tests, and builds...");

        await this.checkPause(runId);
        const verifyNode = this.createVerificationNode(runId, rootNodeId, rootWs);
        this.createEdge(runId, rootNodeId, verifyNode.id, "gate", "verify");

        const verifyResult = await this.runVerificationNode(verifyNode, getSignal());

        if (verifyResult.ok) {
          // ═══════════════════════════════════════════════════════════════════════
          // DOCS_SYNC PHASE - Section 2.1 (before DONE)
          // ═══════════════════════════════════════════════════════════════════════
          const docsSyncResult = await this.runDocsSyncPhase(runId, rootNodeId, getSignal);

          const acceptanceResult = this.evaluateAcceptanceCriteria({
            runId,
            repoPath: run.repoPath,
            verification: verifyResult.report,
          });

          const completionIssues: string[] = [];
          if (!stepsOk) completionIssues.push("One or more plan steps did not complete successfully.");
          if (!acceptanceResult.ok) {
            const failedIds = acceptanceResult.failures.map((c) => c.id).join(", ");
            completionIssues.push(`Acceptance criteria failed: ${failedIds || "unspecified"}.`);
          }
          if (!docsSyncResult.ok) completionIssues.push("Documentation sync did not complete successfully.");

          const completionReport: CompletionReport = {
            ok: completionIssues.length === 0,
            stepsOk,
            acceptanceOk: acceptanceResult.ok,
            docsSynced: docsSyncResult.ok,
            issues: completionIssues,
            acceptanceFailures: acceptanceResult.failures,
          };

          const completionArtifact = this.store.createArtifact({
            runId,
            nodeId: rootNodeId,
            kind: "json",
            name: "completeness.report.json",
            mimeType: "application/json",
            content: JSON.stringify(completionReport, null, 2),
          });
          this.bus.emitArtifact(runId, completionArtifact);

          if (!completionReport.ok) {
            const changesSummary = this.collectChangesSummary(runId);
            const fixContextSections: string[] = [];
            if (acceptanceResult.failures.length > 0) {
              fixContextSections.push("## Acceptance Failures");
              for (const failure of acceptanceResult.failures) {
                fixContextSections.push(`- ${failure.id}: ${failure.description}`);
              }
            }
            if (changesSummary.hasChanges) {
              fixContextSections.push("## Last Patch Summary");
              fixContextSections.push(changesSummary.summary || "No summary available.");
              if (changesSummary.filesChanged.length > 0) {
                fixContextSections.push(`Files: ${changesSummary.filesChanged.join(", ")}`);
              }
            }
            lastFixContext = fixContextSections.join("\n");

            iteration++;
            this.bus.emitRunPatch(runId, { id: runId, iterations: iteration }, "run.updated");
            this.bus.emitNodeProgress(runId, rootNodeId, `COMPLETENESS: Failed. Starting fix iteration ${iteration}...`);

            plan = {
              summary: "auto-fix (v0)",
              steps: [
                {
                  id: `fix-${iteration}`,
                  title: `Fix completeness issues (iteration ${iteration})`,
                  instructions: [
                    "Resolve the completion issues listed below.",
                    "",
                    lastFixContext,
                  ].join("\n"),
                  agentHint: "any",
                  deps: [],
                },
              ],
            };

            const runForFixPlan = this.store.getRun(runId);
            if (runForFixPlan) {
              runForFixPlan.taskDag = plan;
              this.store.persistRun(runForFixPlan);
            }

            continue;
          }

          // ═══════════════════════════════════════════════════════════════════════
          // DONE PHASE - Section 2.1
          // ═══════════════════════════════════════════════════════════════════════
          this.transitionPhase(runId, "DONE", "All checks passed");
          this.bus.emitNodeProgress(runId, rootNodeId, "DONE: Run completed successfully.");

          const finalReport = this.buildFinalReport(runId, {
            verification: verifyResult.report,
            docsSync: docsSyncResult,
            completion: completionReport,
            iterations: iteration + 1,
          });
          const reportArtifact = this.store.createArtifact({
            runId,
            nodeId: rootNodeId,
            kind: "report",
            name: "final.report.md",
            mimeType: "text/markdown",
            content: finalReport,
          });
          this.bus.emitArtifact(runId, reportArtifact);

          if (this.cfg.workspace?.cleanupOnDone) {
            try {
              await this.workspace.cleanupRunWorkspaces(run.repoPath, runId);
            } catch {
              this.bus.emitNodeProgress(runId, rootNodeId, "DONE: Workspace cleanup failed.");
            }
          }

          this.bus.emitNodePatch(runId, rootNodeId, { status: "completed", completedAt: nowIso() }, "node.completed");
          this.bus.emitRunPatch(runId, { id: runId, status: "completed", iterations: iteration + 1 }, "run.completed");
          return;
        } else {
          // collect last verify logs for fix prompt
          if (!verifyResult.report.docsCheck.ok) {
            this.transitionPhase(runId, "DOCS_ITERATION", "Missing required documentation");
            await this.runDocsIterationPhase(runId, rootNodeId, getSignal);
          }
          const logText = this.collectLatestVerificationLog(runId, verifyNode.id);
          const changesSummary = this.collectChangesSummary(runId);
          const reportText = JSON.stringify(verifyResult.report, null, 2);
          const fixContext = [
            logText ? "## Verification Logs" : "",
            logText,
            "## Verification Report",
            "```json",
            reportText,
            "```",
            changesSummary.hasChanges ? "## Last Patch Summary" : "",
            changesSummary.summary,
          ].filter((section) => section.trim().length > 0).join("\n\n");
          lastFixContext = fixContext;
          iteration++;
          this.bus.emitRunPatch(runId, { id: runId, iterations: iteration }, "run.updated");
          this.bus.emitNodeProgress(runId, rootNodeId, `VERIFY: Failed. Starting fix iteration ${iteration}...`);

          // In v0, we do not re-plan; we just run a single fix step next iteration.
          plan = {
            summary: "auto-fix (v0)",
            steps: [
              {
                id: `fix-${iteration}`,
                title: `Fix verification failures (iteration ${iteration})`,
                instructions: [
                  "Fix the verification failures described below.",
                  "",
                  lastFixContext,
                ].join("\n"),
                agentHint: "any",
                deps: [],
              },
            ],
          };

          const runForFixPlan = this.store.getRun(runId);
          if (runForFixPlan) {
            runForFixPlan.taskDag = plan;
            this.store.persistRun(runForFixPlan);
          }
        }

      } catch (e: unknown) {
        const errMessage = e instanceof Error ? e.message : String(e);
        if (this.pauseSignals.has(runId)) {
          // It was a pause interrupt. Loop around to wait.
          this.bus.emitNodeProgress(runId, rootNodeId, "Run interrupted for pause.");
          continue;
        } else if (errMessage === "MODE_INTERACTIVE") {
          // Mode switched to INTERACTIVE. Loop around to wait for AUTO.
          this.bus.emitNodeProgress(runId, rootNodeId, "Run paused - switched to INTERACTIVE mode.");
          continue;
        } else if (errMessage === "aborted") {
          // Standard stop
          break;
        } else {
           throw e; // Crash
        }
      }
    }

    // aborted
    this.bus.emitRunPatch(runId, { id: runId, status: "stopped" }, "run.stopped");
    this.bus.emitNodePatch(runId, rootNodeId, { status: "skipped", completedAt: nowIso() }, "node.completed");
  }

  private createTaskNode(params: {
    runId: string;
    parentNodeId: string;
    label: string;
    role: RoleId;
    providerId: string;
    input?: unknown;
  }): NodeRecord {
    const id = randomUUID();
    const node: NodeRecord = {
      id,
      runId: params.runId,
      parentNodeId: params.parentNodeId,
      type: "task",
      label: params.label,
      role: params.role,
      providerId: params.providerId,
      status: "queued",
      createdAt: nowIso(),
      input: params.input,
    };
    this.bus.emitNodePatch(params.runId, id, node, "node.created");
    return node;
  }

  private createVerificationNode(runId: string, parentNodeId: string, workspacePath: string): NodeRecord {
    const id = randomUUID();
    const node: NodeRecord = {
      id,
      runId,
      parentNodeId,
      type: "verification",
      label: "Verify",
      status: "queued",
      createdAt: nowIso(),
      workspacePath,
    };
    this.bus.emitNodePatch(runId, id, node, "node.created");
    return node;
  }

  public createEdge(runId: string, from: string, to: string, type: EdgeRecord["type"], label?: string): void {
    const edge: EdgeRecord = {
      id: randomUUID(),
      runId,
      from,
      to,
      type,
      label,
      createdAt: nowIso(),
    };
    this.bus.emitEdge(runId, edge);
  }

  private pickProviderForStep(step: TaskStep): string {
    const hint = step.agentHint ?? "any";
    if (hint && hint !== "any") return hint;
    // default implementer role provider
    return this.cfg.roles["implementer"] ?? "mock";
  }

  private schemaJson(name: "plan" | "repo-brief"): string | undefined {
    try {
      const schemaPath = path.resolve(process.cwd(), "..", "..", "docs", "schemas", `${name}.schema.json`);
      if (fs.existsSync(schemaPath)) return fs.readFileSync(schemaPath, "utf-8");
    } catch {
      // ignore
    }
    return undefined;
  }

  private validateStructuredOutput(
    name: "plan" | "repo-brief",
    output: unknown
  ): { ok: boolean; issue?: string } {
    if (name !== "plan") return { ok: true };
    if (!this.isRecord(output)) return { ok: false, issue: "Output must be a JSON object." };

    const steps = output["steps"];
    if (!Array.isArray(steps) || steps.length === 0) {
      return { ok: false, issue: "Plan must include a non-empty steps array." };
    }

    for (const step of steps) {
      if (!this.isRecord(step)) {
        return { ok: false, issue: "Each step must be an object." };
      }
      const idValue = step["id"];
      const titleValue = step["title"];
      const instructionsValue = step["instructions"];
      if (typeof idValue !== "string" || idValue.trim().length === 0) {
        return { ok: false, issue: "Each step must include a non-empty id." };
      }
      if (typeof titleValue !== "string" || titleValue.trim().length === 0) {
        return { ok: false, issue: "Each step must include a non-empty title." };
      }
      if (typeof instructionsValue !== "string" || instructionsValue.trim().length === 0) {
        return { ok: false, issue: "Each step must include non-empty instructions." };
      }
    }

    return { ok: true };
  }

  private buildFollowupPrompt(issue?: string): string {
    const lines = [
      "The previous response did not match the required schema.",
      "Please return ONLY valid JSON that matches the schema.",
    ];
    if (issue) lines.push(`Validation issue: ${issue}`);
    return lines.join("\n");
  }

  private async runProviderNode(
    node: NodeRecord,
    provider: ProviderAdapter,
    params: { prompt: string; outputSchemaName?: "plan" | "repo-brief" },
    signal: AbortSignal
  ): Promise<unknown> {
    const runId = node.runId;
    const wsPath = await this.workspace.prepareWorkspace({
      repoPath: this.store.getRun(runId)!.repoPath,
      runId,
      nodeId: node.id,
    });
    this.bus.emitNodePatch(runId, node.id, { status: "running", startedAt: nowIso(), workspacePath: wsPath }, "node.started");

    const schemaJson = params.outputSchemaName ? this.schemaJson(params.outputSchemaName) : undefined;

    const maxTurns = Math.max(1, this.cfg.orchestration.maxTurnsPerNode ?? 1);
    let finalOutput: unknown = undefined;
    let finalSummary: string | undefined = undefined;
    let validationIssue: string | undefined = undefined;
    let turnsUsed = 0;

    try {
      for (let turn = 1; turn <= maxTurns; turn += 1) {
        turnsUsed = turn;
        const turnPrompt = turn === 1 ? params.prompt : this.buildFollowupPrompt(validationIssue);
        if (turn > 1) {
          this.bus.emitNodeProgress(runId, node.id, `AUTO: Re-prompting for structured output (${turn}/${maxTurns}).`);
        }

        // Get existing session ID for resumption (Section 4.2.2)
        const existingSession = this.sessionRegistry.getByNodeId(node.id);
        const sessionId = node.providerSessionId ?? existingSession?.providerSessionId;

        finalOutput = undefined;
        finalSummary = undefined;

        const iter = provider.runTask(
          {
            runId,
            nodeId: node.id,
            role: node.role ?? "implementer",
            prompt: turnPrompt,
            workspacePath: wsPath,
            outputSchemaJson: schemaJson,
            sessionId, // Pass session for continuity
          },
          signal
        );

        for await (const ev of iter) {
          if (signal.aborted) throw new Error("aborted");
          await this.handleProviderEvent(ev, runId, node, provider);

          // Update finalOutput and finalSummary if this is a final event
          if (ev.type === "final") {
            finalOutput = ev.output ?? finalOutput;
            finalSummary = ev.summary ?? finalSummary;
          }
          // best-effort: treat named plan outputs as finalOutput
          if (ev.type === "json" && String(ev.name).includes("plan")) {
            finalOutput = ev.json;
          }
        }

        if (params.outputSchemaName) {
          const validation = this.validateStructuredOutput(params.outputSchemaName, finalOutput);
          if (!validation.ok) {
            validationIssue = validation.issue;
            if (turn < maxTurns) continue;
          }
        }

        break;
      }

      const run = this.store.getRun(runId);
      if (run) {
        const storedNode = run.nodes[node.id];
        if (storedNode) {
          const currentTurns = storedNode.turnCount ?? 0;
          storedNode.turnCount = currentTurns + turnsUsed;
          this.store.persistRun(run);
        }
      }

      // Capture git diff if possible
      const diff = this.workspace.captureGitDiff(wsPath);
      if (diff.ok && (diff.diff.trim().length || diff.status.trim().length)) {
        const diffArt = this.store.createArtifact({
          runId,
          nodeId: node.id,
          kind: "diff",
          name: "git.diff.patch",
          mimeType: "text/plain",
          content: diff.diff,
          meta: { source: "git diff" },
        });
        this.bus.emitArtifact(runId, diffArt);

        const statusArt = this.store.createArtifact({
          runId,
          nodeId: node.id,
          kind: "text",
          name: "git.status.txt",
          mimeType: "text/plain",
          content: diff.status,
          meta: { source: "git status --porcelain" },
        });
        this.bus.emitArtifact(runId, statusArt);
      }

      this.bus.emitNodePatch(runId, node.id, {
        status: "completed",
        completedAt: nowIso(),
        output: finalOutput,
        summary: finalSummary ?? "completed",
      }, "node.completed");

      return finalOutput;
    } catch (e: unknown) {
      if (signal.aborted) throw new Error("aborted"); // propagate proper abort

      const message = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? e.stack : undefined;
      this.bus.emitNodePatch(runId, node.id, {
        status: "failed",
        completedAt: nowIso(),
        error: { message, stack },
      }, "node.failed");
      throw e;
    }
  }

  private async runVerificationNode(node: NodeRecord, signal: AbortSignal): Promise<VerificationResult> {
    const runId = node.runId;
    this.bus.emitNodePatch(runId, node.id, { status: "running", startedAt: nowIso() }, "node.started");

    const run = this.store.getRun(runId)!;
    const commands = (this.cfg.verification.commands ?? []).filter((c) => String(c).trim().length);

    let verifyOk = true;
    let verifyResults: Array<{
      command: string;
      ok: boolean;
      code: number | null;
      durationMs: number;
      stdout: string;
      stderr: string;
    }> = [];

    if (!commands.length) {
      this.bus.emitNodeProgress(runId, node.id, "No verification commands configured; treating as PASS.");
    } else {
      const result = await verifyAll(commands, { cwd: run.repoPath, signal });
      verifyOk = result.ok;
      verifyResults = result.results;
    }

    // persist logs per command
    const commandsOut: VerificationCommandReport[] = [];
    for (const r of verifyResults) {
      const combined = `# ${r.command}\n\nEXIT=${r.code}\n\n--- STDOUT ---\n${r.stdout}\n\n--- STDERR ---\n${r.stderr}\n`;
      const art = this.store.createArtifact({
        runId,
        nodeId: node.id,
        kind: "log",
        name: `verify_${sanitizeFileName(r.command)}.log`,
        mimeType: "text/plain",
        content: combined,
        meta: { command: r.command, ok: r.ok, code: r.code, durationMs: r.durationMs },
      });
      this.bus.emitArtifact(runId, art);
      commandsOut.push({
        command: r.command,
        ok: r.ok,
        code: r.code,
        durationMs: r.durationMs,
        logArtifactId: art.id,
      });
    }

    const docsInventory = this.detectDocsInventory(run.repoPath);
    run.docsInventory = docsInventory;
    this.store.persistRun(run);

    const docsCheck = {
      ok: docsInventory.missingRequired.length === 0,
      missing: docsInventory.missingRequired,
    };

    const overallOk = verifyOk && docsCheck.ok;
    const report: VerificationReport = {
      ok: overallOk,
      commands: commandsOut,
      docsCheck,
    };

    const reportArtifact = this.store.createArtifact({
      runId,
      nodeId: node.id,
      kind: "json",
      name: "verification.report.json",
      mimeType: "application/json",
      content: JSON.stringify(report, null, 2),
    });
    this.bus.emitArtifact(runId, reportArtifact);

    this.bus.emitVerificationCompleted(runId, node.id, {
      ok: report.ok,
      commands: report.commands.map((r) => ({
        command: r.command,
        ok: r.ok,
        code: r.code,
        durationMs: r.durationMs,
        logArtifactId: r.logArtifactId,
      })),
      docsCheck: report.docsCheck,
    });

    if (overallOk) {
      this.bus.emitNodePatch(runId, node.id, { status: "completed", completedAt: nowIso(), summary: "Verification PASS." }, "node.completed");
    } else {
      this.bus.emitNodePatch(runId, node.id, { status: "failed", completedAt: nowIso(), summary: "Verification FAIL." }, "node.failed");
    }

    return { ok: overallOk, report, reportArtifactId: reportArtifact.id };
  }

  private collectLatestVerificationLog(runId: string, verifyNodeId: string): string {
    const run = this.store.getRun(runId);
    if (!run) return "";
    // Collect the most recent verification log artifacts for this node.
    const logs = Object.values(run.artifacts)
      .filter((a) => a.nodeId === verifyNodeId && a.kind === "log")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 3);

    let combined = "";
    for (const a of logs) {
      try {
        combined += `\n\n## Artifact: ${a.name}\n`;
        combined += fs.readFileSync(a.path, "utf-8");
      } catch {
        // ignore
      }
    }
    return combined.trim();
  }

  private collectUserFeedback(runId: string): string {
    const run = this.store.getRun(runId);
    if (!run) return "";
    const feedback = Object.values(run.artifacts)
      .filter((a) => a.kind === "user_feedback")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    
    if (!feedback.length) return "";

    let combined = "";
    for (const a of feedback) {
      try {
        const content = fs.readFileSync(a.path, "utf-8");
        combined += `\n--- USER INTERVENTION (${a.createdAt}) ---\n${content}\n`;
      } catch {
        // ignore
      }
    }
    return combined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private normalizeCheckType(value: unknown): AcceptanceCriterion["checkType"] {
    if (typeof value !== "string") return "custom";
    switch (value) {
      case "test":
      case "lint":
      case "build":
      case "manual":
      case "doc_exists":
      case "custom":
        return value;
      default:
        return "custom";
    }
  }

  private normalizeAcceptanceCriteria(value: unknown): AcceptanceCriterion[] {
    if (!Array.isArray(value)) return [];
    const criteria: AcceptanceCriterion[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      if (!this.isRecord(item)) continue;
      const idValue = item["id"];
      const descriptionValue = item["description"];
      const id = typeof idValue === "string" && idValue.trim().length > 0
        ? idValue
        : `accept-${i + 1}`;
      const description = typeof descriptionValue === "string" ? descriptionValue.trim() : "";
      if (!description) continue;
      const checkType = this.normalizeCheckType(item["checkType"]);
      const checkCommandValue = item["checkCommand"];
      const checkCommand = typeof checkCommandValue === "string" && checkCommandValue.trim().length > 0
        ? checkCommandValue
        : undefined;
      criteria.push({ id, description, checkType, checkCommand });
    }
    return criteria;
  }

  private deriveAcceptanceCriteriaFromCommands(commands: string[]): AcceptanceCriterion[] {
    const criteria: AcceptanceCriterion[] = [];
    for (let i = 0; i < commands.length; i += 1) {
      const command = commands[i];
      const checkType = this.classifyCommand(command);
      criteria.push({
        id: `verify-${i + 1}`,
        description: `Command succeeds: ${command}`,
        checkType,
        checkCommand: command,
      });
    }
    return criteria;
  }

  private normalizePlanOutput(output: unknown, fallbackPrompt: string): NormalizedPlan {
    const fallbackTaskDag: TaskDagRecord = {
      summary: "auto-plan (fallback)",
      steps: [
        {
          id: "impl-1",
          title: "Implement requested changes",
          instructions: fallbackPrompt,
          agentHint: "any",
          deps: [],
        },
      ],
    };

    if (!this.isRecord(output)) {
      return {
        taskDag: fallbackTaskDag,
        acceptanceCriteria: this.deriveAcceptanceCriteriaFromCommands(this.cfg.verification.commands ?? []),
        usedFallback: true,
      };
    }

    const stepsValue = output["steps"];
    if (!Array.isArray(stepsValue) || stepsValue.length === 0) {
      return {
        taskDag: fallbackTaskDag,
        acceptanceCriteria: this.deriveAcceptanceCriteriaFromCommands(this.cfg.verification.commands ?? []),
        usedFallback: true,
      };
    }

    const steps: TaskStep[] = [];
    for (let i = 0; i < stepsValue.length; i += 1) {
      const raw = stepsValue[i];
      if (!this.isRecord(raw)) continue;
      const idValue = raw["id"];
      const titleValue = raw["title"];
      const instructionsValue = raw["instructions"];
      const agentHintValue = raw["agentHint"];
      const depsValue = raw["deps"];

      const id = typeof idValue === "string" && idValue.trim().length > 0 ? idValue : `step-${i + 1}`;
      const title = typeof titleValue === "string" && titleValue.trim().length > 0 ? titleValue : id;
      const instructions = typeof instructionsValue === "string" && instructionsValue.trim().length > 0
        ? instructionsValue
        : title;
      const agentHint = typeof agentHintValue === "string" && agentHintValue.trim().length > 0
        ? agentHintValue
        : "any";
      const deps = Array.isArray(depsValue)
        ? depsValue.filter((dep) => typeof dep === "string")
        : [];

      steps.push({ id, title, instructions, agentHint, deps });
    }

    if (!steps.length) {
      return {
        taskDag: fallbackTaskDag,
        acceptanceCriteria: this.deriveAcceptanceCriteriaFromCommands(this.cfg.verification.commands ?? []),
        usedFallback: true,
      };
    }

    const summaryValue = output["summary"];
    const summary = typeof summaryValue === "string" && summaryValue.trim().length > 0
      ? summaryValue
      : "plan";

    const acceptanceRaw = output["acceptanceCriteria"];
    const acceptanceFromPlan = this.normalizeAcceptanceCriteria(acceptanceRaw);
    const acceptanceCriteria = acceptanceFromPlan.length > 0
      ? acceptanceFromPlan
      : this.deriveAcceptanceCriteriaFromCommands(this.cfg.verification.commands ?? []);

    return {
      taskDag: { summary, steps },
      acceptanceCriteria,
      usedFallback: false,
    };
  }

  private formatPlanMarkdown(taskDag: TaskDagRecord): string {
    const lines: string[] = [];
    lines.push("# Plan");
    lines.push("");
    lines.push("## Summary");
    lines.push(taskDag.summary || "Plan output");
    lines.push("");
    lines.push("## Steps");

    for (const step of taskDag.steps) {
      lines.push("");
      lines.push(`### ${step.id}: ${step.title}`);
      if (step.instructions) {
        lines.push("");
        lines.push("Instructions:");
        lines.push("```");
        lines.push(step.instructions);
        lines.push("```");
      }
      const deps = step.deps?.length ? step.deps.join(", ") : "None";
      lines.push(`- Dependencies: ${deps}`);
      if (step.agentHint) {
        lines.push(`- Agent hint: ${step.agentHint}`);
      }
    }

    lines.push("");
    return lines.join("\n");
  }

  private formatAcceptanceMarkdown(criteria: AcceptanceCriterion[]): string {
    const lines: string[] = [];
    lines.push("# Acceptance Criteria");
    lines.push("");

    if (criteria.length === 0) {
      lines.push("_No acceptance criteria were generated._");
      lines.push("");
      return lines.join("\n");
    }

    for (const criterion of criteria) {
      lines.push(`- [${criterion.id}] ${criterion.description}`);
      lines.push(`  - Type: ${criterion.checkType}`);
      if (criterion.checkCommand) {
        lines.push(`  - Command: ${criterion.checkCommand}`);
      }
    }

    lines.push("");
    return lines.join("\n");
  }

  private writePlanningArtifacts(repoPath: string, taskDag: TaskDagRecord, criteria: AcceptanceCriterion[]): void {
    const docsDir = path.join(repoPath, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    const planPath = path.join(docsDir, "PLAN.md");
    const acceptancePath = path.join(docsDir, "ACCEPTANCE.md");

    fs.writeFileSync(planPath, this.formatPlanMarkdown(taskDag), "utf-8");
    fs.writeFileSync(acceptancePath, this.formatAcceptanceMarkdown(criteria), "utf-8");
  }

  private extractSteps(plan: TaskDagRecord | null, fallbackPrompt: string, iteration: number, lastVerify: string): TaskStep[] {
    const maybeSteps = plan?.steps;
    if (Array.isArray(maybeSteps) && maybeSteps.length) return maybeSteps;

    // fallback plan
    return [
      {
        id: iteration === 0 ? "impl-1" : `fix-${iteration}`,
        title: iteration === 0 ? "Implement requested changes" : `Fix verification failures (iteration ${iteration})`,
        instructions: iteration === 0 ? fallbackPrompt : `Fix verification failures.\n\nLogs:\n${lastVerify}`,
        agentHint: "any",
        deps: [],
      },
    ];
  }

  private classifyCommand(command: string): AcceptanceCriterion["checkType"] {
    const lower = command.toLowerCase();
    if (lower.includes("lint")) return "lint";
    if (lower.includes("test")) return "test";
    if (lower.includes("build")) return "build";
    return "custom";
  }

  private checkDocExists(repoPath: string, relativePath: string): boolean {
    const normalized = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
    const useRepoPath = !path.isAbsolute(relativePath) || normalized.startsWith("docs/");
    const fullPath = useRepoPath ? path.join(repoPath, normalized) : relativePath;
    if (!fs.existsSync(fullPath)) return false;
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      return content.trim().length > 0;
    } catch {
      return false;
    }
  }

  private evaluateAcceptanceCriteria(params: {
    runId: string;
    repoPath: string;
    verification: VerificationReport;
  }): { ok: boolean; failures: AcceptanceCriterion[] } {
    const run = this.store.getRun(params.runId);
    if (!run) return { ok: true, failures: [] };

    const criteria = run.acceptanceCriteria ?? [];
    if (criteria.length === 0) return { ok: true, failures: [] };

    const failures: AcceptanceCriterion[] = [];
    const updated: AcceptanceCriterion[] = [];
    const checkTime = nowIso();

    for (const criterion of criteria) {
      let passed = false;

      if (criterion.checkType === "doc_exists") {
        if (criterion.checkCommand) {
          passed = this.checkDocExists(params.repoPath, criterion.checkCommand);
        } else {
          const inventory = this.detectDocsInventory(params.repoPath);
          run.docsInventory = inventory;
          passed = inventory.missingRequired.length === 0;
        }
      } else if (criterion.checkType === "manual") {
        passed = criterion.passed === true;
      } else if (criterion.checkType === "test" || criterion.checkType === "lint" || criterion.checkType === "build") {
        const matches = criterion.checkCommand
          ? params.verification.commands.filter((c) => c.command === criterion.checkCommand)
          : params.verification.commands.filter((c) => this.classifyCommand(c.command) === criterion.checkType);
        passed = matches.length > 0 && matches.every((c) => c.ok);
      } else {
        const matches = criterion.checkCommand
          ? params.verification.commands.filter((c) => c.command === criterion.checkCommand)
          : [];
        passed = matches.length > 0 ? matches.every((c) => c.ok) : criterion.passed === true;
      }

      const updatedCriterion: AcceptanceCriterion = {
        ...criterion,
        passed,
        checkedAt: checkTime,
      };
      updated.push(updatedCriterion);
      if (!passed) failures.push(updatedCriterion);
    }

    run.acceptanceCriteria = updated;
    this.store.persistRun(run);

    return { ok: failures.length === 0, failures };
  }

  private updateTaskDagNodeLinks(runId: string, stepNodes: Array<{ step: TaskStep; node: NodeRecord }>): void {
    const run = this.store.getRun(runId);
    if (!run?.taskDag) return;

    const stepMap = new Map<string, TaskStep>();
    for (const step of run.taskDag.steps) {
      stepMap.set(step.id, step);
    }

    for (const sn of stepNodes) {
      const step = stepMap.get(sn.step.id);
      if (!step) continue;
      step.nodeId = sn.node.id;
      step.status = step.status ?? "pending";
    }

    this.store.persistRun(run);
  }

  private updateTaskDagStatuses(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run?.taskDag) return;

    for (const step of run.taskDag.steps) {
      if (!step.nodeId) continue;
      const node = run.nodes[step.nodeId];
      if (!node) continue;
      switch (node.status) {
        case "running":
          step.status = "running";
          break;
        case "completed":
          step.status = "completed";
          break;
        case "failed":
          step.status = "failed";
          break;
        case "skipped":
          step.status = "skipped";
          break;
        default:
          step.status = "pending";
      }
    }

    this.store.persistRun(run);
  }

  private allStepsCompleted(runId: string, stepNodes: Array<{ step: TaskStep; node: NodeRecord }>): boolean {
    const run = this.store.getRun(runId);
    if (!run) return true;

    for (const sn of stepNodes) {
      const node = run.nodes[sn.node.id];
      if (!node || node.status !== "completed") return false;
    }
    return true;
  }

  // Prompt builders

  private buildInvestigationPrompt(userPrompt: string, repoPath: string): string {
    return [
      "You are an investigator agent inside vuhlp code.",
      "Goal: quickly understand the repo and identify how to validate changes.",
      "",
      `Repo path: ${repoPath}`,
      "",
      "Return a short summary and suggested verification commands.",
      "",
      "User request:",
      userPrompt,
    ].join("\n");
  }

  private buildPlanningPrompt(userPrompt: string, lastVerifyLog: string, userFeedback: string): string {
    return [
      "You are a planner agent inside vuhlp code.",
      "Create a minimal step plan to satisfy the user request.",
      "",
      "Rules:",
      "- Output JSON matching the provided schema (steps[], deps, acceptanceCriteria).",
      "- Prefer 1-5 steps.",
      "- Include deps only when required.",
      "- Include acceptance criteria; prefer automated checks over manual.",
      "",
      "User request:",
      userPrompt,
      "",
      lastVerifyLog ? `Recent verification failures (if any):\n${lastVerifyLog}` : "",
      "",
      userFeedback ? `USER FEEDBACK (CRITICAL - FOLLOW THESE INSTRUCTIONS):\n${userFeedback}` : "",
    ].join("\n");
  }

  private buildStepPrompt(runId: string, nodeId: string, userPrompt: string, step: TaskStep, iteration: number, lastVerifyLog: string, userFeedback: string): string {
    const run = this.store.getRun(runId);

    // Collect pending chat messages for this node
    const chatSection = this.chatManager.buildChatPromptSection(runId, nodeId);

    // Mark chat messages as processed
    const pendingMessages = this.chatManager.getPendingMessages(runId, nodeId);
    if (pendingMessages.length > 0) {
      this.chatManager.markProcessed(pendingMessages.map((m) => m.id));
    }

    // Build context pack using ContextPackBuilder (Section 5.3.3)
    let contextPackSection = "";
    if (run) {
      const contextPack = this.contextPackBuilder.buildForStep({
        run,
        step,
        repoPath: run.repoPath,
        constraints: {
          mustUpdateDocsOnBehaviorChange: true,
        },
      });
      contextPackSection = this.contextPackBuilder.toPromptSection(contextPack);
    }

    return [
      `You are an implementer agent inside vuhlp code.`,
      `Iteration: ${iteration}`,
      "",
      contextPackSection,
      "",
      "User request:",
      userPrompt,
      "",
      "Your assigned step:",
      `Title: ${step.title ?? step.id}`,
      `Instructions: ${step.instructions ?? ""}`,
      "",
      lastVerifyLog ? `If you are fixing failures, use these logs:\n${lastVerifyLog}` : "",
      "",
      userFeedback ? `USER FEEDBACK (CRITICAL - FOLLOW THESE INSTRUCTIONS):\n${userFeedback}` : "",
      chatSection,
      "",
      "Deliverables:",
      "- Apply code changes in the workspace.",
      "- Keep changes minimal.",
      "- If tests are available, run them (or suggest commands).",
      "- Summarize what you changed and why.",
    ].join("\n");
  }

  private buildReviewPrompt(userPrompt: string): string {
    return [
      "You are a reviewer agent inside vuhlp code.",
      "Review the implementation against the user request.",
      "Return JSON with fields: ok (boolean), issues (array), notes (string).",
      "",
      "User request:",
      userPrompt,
    ].join("\n");
  }

  private buildFinalReport(
    runId: string,
    details: { verification: VerificationReport; docsSync: DocsSyncResult; completion: CompletionReport; iterations?: number }
  ): string {
    const run = this.store.getRun(runId);
    const lines: string[] = [];

    lines.push("# Run Report");
    lines.push("");
    lines.push(`Run ID: ${runId}`);
    if (run) {
      lines.push(`Prompt: ${run.prompt}`);
      lines.push(`Mode: ${run.mode}`);
      const status = details.completion.ok ? "completed" : run.status;
      lines.push(`Status: ${status}`);
      const iterations = details.iterations ?? run.iterations;
      lines.push(`Iterations: ${iterations}`);
    }

    if (run?.taskDag) {
      lines.push("");
      lines.push("## Plan Summary");
      lines.push(run.taskDag.summary || "Plan");
      lines.push("");
      lines.push("### Steps");
      for (const step of run.taskDag.steps) {
        const status = step.status ?? "pending";
        lines.push(`- [${status}] ${step.id}: ${step.title}`);
      }
    }

    if (run?.acceptanceCriteria?.length) {
      lines.push("");
      lines.push("## Acceptance Criteria");
      for (const criterion of run.acceptanceCriteria) {
        const status = criterion.passed ? "PASS" : "FAIL";
        lines.push(`- [${status}] ${criterion.id}: ${criterion.description}`);
      }
    }

    lines.push("");
    lines.push("## Verification");
    lines.push(`Result: ${details.verification.ok ? "PASS" : "FAIL"}`);
    for (const cmd of details.verification.commands) {
      lines.push(`- ${cmd.ok ? "PASS" : "FAIL"}: ${cmd.command} (exit ${cmd.code ?? "n/a"})`);
    }
    if (!details.verification.docsCheck.ok) {
      lines.push(`- Docs missing: ${details.verification.docsCheck.missing.join(", ")}`);
    }

    lines.push("");
    lines.push("## Documentation Sync");
    lines.push(`Updated: ${details.docsSync.hasChanges ? "yes" : "no"}`);

    lines.push("");
    lines.push("## Completeness");
    lines.push(`Result: ${details.completion.ok ? "PASS" : "FAIL"}`);
    if (details.completion.issues.length > 0) {
      for (const issue of details.completion.issues) {
        lines.push(`- ${issue}`);
      }
    }

    lines.push("");
    return lines.join("\n");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROVIDER EVENT HANDLER - Section 4 Integration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle provider output events with proper integration of:
   * - SessionRegistry for session continuity (Section 4.2.2)
   * - ApprovalQueue for tool approvals (Section 4.2.3)
   * - EventBus for message streaming
   */
  private async handleProviderEvent(
    ev: ProviderOutputEvent,
    runId: string,
    node: NodeRecord,
    provider: ProviderAdapter
  ): Promise<void> {
    switch (ev.type) {
      case "progress":
        this.bus.emitNodeProgress(runId, node.id, ev.message, ev.raw);
        break;

      case "log": {
        const art = this.store.createArtifact({
          runId,
          nodeId: node.id,
          kind: "log",
          name: ev.name,
          mimeType: "text/plain",
          content: ev.content,
        });
        this.bus.emitArtifact(runId, art);
        break;
      }

      case "json": {
        const art = this.store.createArtifact({
          runId,
          nodeId: node.id,
          kind: "json",
          name: ev.name,
          mimeType: "application/json",
          content: JSON.stringify(ev.json, null, 2),
        });
        this.bus.emitArtifact(runId, art);
        break;
      }

      case "diff": {
        const art = this.store.createArtifact({
          runId,
          nodeId: node.id,
          kind: "diff",
          name: ev.name,
          mimeType: "text/plain",
          content: ev.patch,
        });
        this.bus.emitArtifact(runId, art);
        break;
      }

      case "session": {
        // Register session in SessionRegistry for continuity (Section 4.2.2)
        node.providerSessionId = ev.sessionId;
        this.sessionRegistry.register({
          nodeId: node.id,
          runId,
          providerId: provider.id,
          providerSessionId: ev.sessionId,
        });
        // Persist the session ID on the node
        const run = this.store.getRun(runId);
        if (run) {
          this.store.persistRun(run);
        }
        break;
      }

      case "message.delta":
        this.bus.emitMessageDelta(runId, node.id, ev.delta, ev.index);
        break;

      case "message.final":
        this.bus.emitMessageFinal(runId, node.id, ev.content, ev.tokenCount);
        break;

      case "message.reasoning":
        // Store reasoning as a rationale summary (Section 0.3)
        this.bus.emitNodeProgress(runId, node.id, `[rationale] ${ev.content.slice(0, 500)}...`);
        break;

      case "tool.proposed": {
        // Emit tool proposed event for UI visibility
        this.bus.emitToolProposed(runId, node.id, ev.tool);

        // Check if we need approval based on run policy, mode, and tool risk
        const run = this.store.getRun(runId);
        const approvalMode = run?.policy?.approvalMode ?? "high_risk_only";

        // Skip approval entirely if approvalMode is "never"
        if (approvalMode === "never") {
          break;
        }

        // Determine if approval is needed
        const needsApproval =
          approvalMode === "always" ||
          run?.mode === "INTERACTIVE" ||
          (approvalMode === "high_risk_only" && ev.tool.riskLevel === "high");

        if (needsApproval) {
          // Queue for approval
          try {
            const resolution = await this.approvalQueue.requestApproval({
              runId,
              nodeId: node.id,
              tool: ev.tool,
              context: `Tool: ${ev.tool.name}\nArgs: ${JSON.stringify(ev.tool.args, null, 2)}`,
            });

            if (resolution.status === "denied") {
              // Tool was denied - this will be handled by the provider
              this.bus.emitNodeProgress(runId, node.id, `Tool ${ev.tool.name} denied: ${resolution.feedback ?? "user denied"}`);
            } else if (resolution.status === "modified" && resolution.modifiedArgs) {
              // Tool args were modified - provider should use modified args
              this.bus.emitNodeProgress(runId, node.id, `Tool ${ev.tool.name} modified by user`);
            }
          } catch {
            // Approval request failed or timed out, continue anyway in AUTO mode
            if (run?.mode !== "INTERACTIVE") {
              this.bus.emitNodeProgress(runId, node.id, `Tool ${ev.tool.name} auto-approved (approval timeout)`);
            }
          }
        }
        break;
      }

      case "tool.started":
        this.bus.emitToolStarted(runId, node.id, ev.toolId);
        break;

      case "tool.completed":
        this.bus.emitToolCompleted(runId, node.id, ev.toolId, ev.result, ev.error, ev.durationMs);
        break;

      case "console":
        this.bus.emitConsoleChunk(runId, node.id, ev.stream, ev.data);
        break;

      case "final":
        // Final event is handled in the calling method
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-PAUSE POLICY CHECKING - Section 3
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if auto-pause should trigger based on the run's policy.
   */
  private shouldAutoPause(runId: string, reason: keyof AutoPausePolicy): boolean {
    const run = this.store.getRun(runId);
    if (!run?.policy?.autoPauseOn) return false;

    const autoPausePolicy = run.policy.autoPauseOn;
    return autoPausePolicy[reason] === true;
  }

  /**
   * Trigger auto-pause if the policy requires it.
   */
  private async checkAutoPausePolicy(runId: string, reason: keyof AutoPausePolicy): Promise<void> {
    if (this.shouldAutoPause(runId, reason)) {
      this.bus.emitNodeProgress(
        runId,
        this.store.getRun(runId)?.rootOrchestratorNodeId ?? "",
        `AUTO_PAUSE triggered: ${reason}`
      );
      this.setRunMode(runId, "INTERACTIVE", `auto_pause:${reason}`);
    }
  }
}

function sanitizeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}
