import { promises as fs } from "fs";
import path from "path";
import type {
  ApprovalRequest,
  ApprovalResolution,
  Artifact,
  ArtifactKind,
  ArtifactMetadata,
  EdgeManagementScope,
  EdgeState,
  Envelope,
  EventEnvelope,
  FileEntry,
  GlobalMode,
  GetRoleTemplateResponse,
  ListDirectoryResponse,
  NodeConnection,
  NodeConfig,
  NodeConfigInput,
  NodeState,
  OrchestrationMode,
  RunState,
  UsageTotals,
  UserMessageRecord,
  UUID
} from "@vuhlp/contracts";
import { EventBus } from "./event-bus.js";
import { ArtifactStore } from "./artifact-store.js";
import { RunStore, type NodeRecord, type RunRecord } from "./store.js";
import { Scheduler } from "./scheduler.js";
import { NoopRunner, type NodeRunner } from "./runner.js";
import { CliRunner } from "./cli-runner.js";
import { newId, nowIso } from "./utils.js";
import {
  ConsoleLogger,
  CreateEdgeRequest,
  CreateEdgeResult,
  type Logger,
  SendHandoffRequest,
  SendHandoffResult,
  SpawnNodeRequest,
  SpawnNodeResult
} from "@vuhlp/providers";

const addUsage = (current: UsageTotals | undefined, delta: UsageTotals): UsageTotals => ({
  promptTokens: (current?.promptTokens ?? 0) + delta.promptTokens,
  completionTokens: (current?.completionTokens ?? 0) + delta.completionTokens,
  totalTokens: (current?.totalTokens ?? 0) + delta.totalTokens
});

export interface RuntimeOptions {
  dataDir: string;
  runner?: NodeRunner;
  stallThreshold?: number;
  repoRoot?: string;
  appRoot?: string;
  systemTemplatesDir?: string;
  logger?: Logger;
}

export class Runtime {
  private readonly store: RunStore;
  private readonly eventBus: EventBus;
  private readonly scheduler: Scheduler;
  private readonly runner: NodeRunner;
  private readonly dataDir: string;
  private readonly repoRoot: string;
  private readonly appRoot: string;
  private readonly systemTemplatesDir?: string;
  private readonly logger: Logger;
  private readonly artifactStores = new Map<UUID, ArtifactStore>();

  constructor(options: RuntimeOptions) {
    this.dataDir = options.dataDir;
    this.repoRoot = path.resolve(options.repoRoot ?? process.cwd());
    this.appRoot = path.resolve(options.appRoot ?? this.repoRoot);
    this.systemTemplatesDir = options.systemTemplatesDir;
    this.logger = options.logger ?? new ConsoleLogger({ scope: "runtime" });
    this.store = new RunStore(this.dataDir);
    this.eventBus = new EventBus();
    this.runner =
      options.runner ??
      new CliRunner({
        repoRoot: this.repoRoot,
        appRoot: this.appRoot,
        emitEvent: this.emitEvent.bind(this),
        spawnNode: this.spawnNodeFromTool.bind(this),
        createEdge: this.createEdgeFromTool.bind(this),
        sendHandoff: this.sendHandoffFromTool.bind(this),
        systemTemplatesDir: this.systemTemplatesDir,
        logger: this.logger
      });
    this.scheduler = new Scheduler({
      store: this.store,
      emitEvent: this.emitEvent.bind(this),
      runner: this.runner,
      dataDir: this.dataDir,
      stallThreshold: options.stallThreshold
    });
  }

  start(): void {
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  onEvent(listener: (event: EventEnvelope) => void): () => void {
    return this.eventBus.on(listener);
  }

  listRuns(): RunState[] {
    return this.store.listRuns();
  }

  getRun(runId: UUID): RunState {
    const record = this.requireRun(runId);
    return record.state;
  }

  async getRoleTemplate(templateName: string): Promise<GetRoleTemplateResponse> {
    const name = templateName.trim();
    if (!name) {
      throw new Error("template name is required");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error("invalid template name");
    }
    const templatePath = path.resolve(this.repoRoot, "docs", "templates", `${name}.md`);
    try {
      const content = await fs.readFile(templatePath, "utf8");
      return { name, content, found: true };
    } catch (error) {
      // fallback to system templates
      if (this.systemTemplatesDir) {
        const systemPath = path.resolve(this.systemTemplatesDir, `${name}.md`);
        try {
          const content = await fs.readFile(systemPath, "utf8");
          return { name, content, found: true };
        } catch (sysError) {
          // ignore
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("role template not found", { name, message, templatePath });
      return { name, content: `Role template not found: ${name}`, found: false };
    }
  }

  async getEvents(runId: UUID): Promise<EventEnvelope[]> {
    const record = this.requireRun(runId);
    return record.eventLog.readAll();
  }

  updateRun(
    runId: UUID,
    patch: Partial<Pick<RunState, "status" | "mode" | "globalMode">>
  ): RunState {
    const record = this.requireRun(runId);
    const now = nowIso();
    const updates: Partial<RunState> = {};
    const previousStatus = record.state.status;

    if (patch.status !== undefined) {
      record.state.status = patch.status;
      updates.status = patch.status;
    }
    if (patch.mode !== undefined) {
      record.state.mode = patch.mode;
      updates.mode = patch.mode;
    }
    if (patch.globalMode !== undefined) {
      record.state.globalMode = patch.globalMode;
      updates.globalMode = patch.globalMode;
    }

    record.state.updatedAt = now;
    updates.updatedAt = now;

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "run.patch",
      patch: updates
    });

    if (updates.mode || updates.globalMode) {
      this.emitEvent(runId, {
        id: newId(),
        runId,
        ts: now,
        type: "run.mode",
        mode: record.state.mode,
        globalMode: record.state.globalMode
      });
    }

    if (updates.status === "paused" && previousStatus !== "paused") {
      this.interruptRun(record, now);
    }

    if (updates.status === "stopped" && previousStatus !== "stopped") {
      this.stopRun(record, now);
    }

    if (updates.status === "running" && previousStatus === "paused") {
      this.resumeInterruptedNodes(record);
    }

    return record.state;
  }

  async deleteRun(runId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const now = nowIso();

    if (this.runner.disposeNode) {
      for (const nodeRecord of record.nodes.values()) {
        nodeRecord.runtime.cancelRequested = true;
        try {
          await this.runner.disposeNode(nodeRecord.state.id);
        } catch (error) {
          this.logger.error("failed to dispose node session", {
            nodeId: nodeRecord.state.id,
            runId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    this.store.deleteRun(runId);
    this.artifactStores.delete(runId);

    try {
      await fs.rm(path.join(this.dataDir, "runs", runId), { recursive: true, force: true });
    } catch (error) {
      this.logger.error("failed to remove run data", {
        runId,
        compiler: "runtime",
        message: error instanceof Error ? error.message : String(error),
        ts: now
      });
    }
  }

  async resetNode(runId: UUID, nodeId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const nodeRecord = this.requireNode(record, nodeId);
    const now = nowIso();

    nodeRecord.runtime.pendingTurn = false;
    nodeRecord.runtime.inbox = [];
    nodeRecord.runtime.queuedMessages = [];
    nodeRecord.runtime.summaryHistory = [];
    nodeRecord.runtime.outputRepeatCount = 0;
    nodeRecord.runtime.diffRepeatCount = 0;
    nodeRecord.runtime.verificationRepeatCount = 0;
    nodeRecord.runtime.lastOutputHash = undefined;
    nodeRecord.runtime.lastDiffHash = undefined;
    nodeRecord.runtime.lastVerificationFailure = undefined;
    nodeRecord.state.inboxCount = 0;
    if (this.runner.resetNode) {
      try {
        await this.runner.resetNode(nodeId);
      } catch (error) {
        this.logger.error("failed to reset node session", {
          nodeId,
          runId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const idleConnection: NodeConnection | undefined = nodeRecord.state.connection
      ? {
        ...nodeRecord.state.connection,
        status: "idle",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      }
      : undefined;

    nodeRecord.state = {
      ...nodeRecord.state,
      status: "idle",
      summary: "context reset",
      lastActivityAt: now,
      connection: idleConnection
    };
    record.state.nodes[nodeId] = nodeRecord.state;
    record.state.updatedAt = now;

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId,
      patch: {
        status: "idle",
        summary: "context reset",
        lastActivityAt: now,
        connection: idleConnection
      }
    });

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.progress",
      nodeId,
      status: "idle",
      summary: "context reset"
    });
  }

  async startNodeProcess(runId: UUID, nodeId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const nodeRecord = this.requireNode(record, nodeId);
    const now = nowIso();

    if (!this.runner.startNode) {
      throw new Error("Runner does not support starting node sessions");
    }

    try {
      await this.runner.startNode({
        run: record.state,
        node: nodeRecord.state,
        config: nodeRecord.config
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to start node session", {
        nodeId,
        runId,
        message
      });
      throw error;
    }

    const connection: NodeConnection = nodeRecord.state.connection
      ? {
        ...nodeRecord.state.connection,
        status: "idle",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      }
      : {
        status: "idle",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      };
    const summary =
      nodeRecord.state.connection?.status === "disconnected"
        ? "process started"
        : nodeRecord.state.summary;

    nodeRecord.state = {
      ...nodeRecord.state,
      summary,
      lastActivityAt: now,
      connection
    };
    record.state.nodes[nodeId] = nodeRecord.state;
    record.state.updatedAt = now;

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId,
      patch: {
        summary,
        lastActivityAt: now,
        connection
      }
    });
  }

  async stopNodeProcess(runId: UUID, nodeId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const nodeRecord = this.requireNode(record, nodeId);
    const now = nowIso();

    if (!this.runner.stopNode) {
      throw new Error("Runner does not support stopping node sessions");
    }

    if (nodeRecord.state.status === "running") {
      nodeRecord.runtime.cancelRequested = true;
    }
    nodeRecord.runtime.pendingTurn = false;
    for (const [approvalId, approval] of record.approvals.entries()) {
      if (approval.nodeId === nodeId) {
        record.approvals.delete(approvalId);
      }
    }

    try {
      await this.runner.stopNode(nodeId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to stop node session", {
        nodeId,
        runId,
        message
      });
      throw error;
    }

    const connection: NodeConnection = nodeRecord.state.connection
      ? {
        ...nodeRecord.state.connection,
        status: "disconnected",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      }
      : {
        status: "disconnected",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      };

    nodeRecord.state = {
      ...nodeRecord.state,
      status: "idle",
      summary: "process stopped",
      lastActivityAt: now,
      connection
    };
    record.state.nodes[nodeId] = nodeRecord.state;
    record.state.updatedAt = now;

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId,
      patch: {
        status: "idle",
        summary: "process stopped",
        lastActivityAt: now,
        connection
      }
    });
  }

  async interruptNodeProcess(runId: UUID, nodeId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const nodeRecord = this.requireNode(record, nodeId);

    if (!this.runner.interruptNode) {
      throw new Error("Runner does not support interrupting node sessions");
    }

    if (nodeRecord.state.status !== "running") {
      throw new Error("Node is not running");
    }

    try {
      await this.runner.interruptNode(nodeId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to interrupt node session", {
        nodeId,
        runId,
        message
      });
      throw error;
    }
  }

  async deleteNode(runId: UUID, nodeId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const now = nowIso();
    const nodeRecord = record.nodes.get(nodeId);
    if (!nodeRecord) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (this.runner.disposeNode) {
      nodeRecord.runtime.cancelRequested = true;
      try {
        await this.runner.disposeNode(nodeId);
      } catch (error) {
        this.logger.error("failed to dispose node session", {
          nodeId,
          runId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    for (const [edgeId, edge] of record.edges.entries()) {
      if (edge.from === nodeId || edge.to === nodeId) {
        record.edges.delete(edgeId);
        delete record.state.edges[edgeId];
        this.emitEvent(runId, {
          id: newId(),
          runId,
          ts: now,
          type: "edge.deleted",
          edgeId
        });
      }
    }

    for (const [approvalId, approval] of record.approvals.entries()) {
      if (approval.nodeId === nodeId) {
        record.approvals.delete(approvalId);
      }
    }

    record.nodes.delete(nodeId);
    delete record.state.nodes[nodeId];
    record.state.updatedAt = now;

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.deleted",
      nodeId
    });

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "run.patch",
      patch: { updatedAt: now }
    });
  }

  async getArtifactContent(runId: UUID, artifactId: UUID): Promise<{ artifact: Artifact; content: string }> {
    const record = this.requireRun(runId);
    const artifact = record.artifacts.get(artifactId) ?? record.state.artifacts[artifactId];
    if (!artifact) {
      throw new Error(`Artifact ${artifactId} not found`);
    }
    const content = await fs.readFile(artifact.path, "utf8");
    return { artifact, content };
  }

  async listDirectory(dirPath?: string): Promise<ListDirectoryResponse> {
    const target = dirPath ? path.resolve(dirPath) : process.cwd();
    const entries = await fs.readdir(target, { withFileTypes: true });

    const files: FileEntry[] = entries
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        path: path.join(target, entry.name)
      }))
      .filter((entry) => !entry.name.startsWith(".")) // simple hidden filter
      .sort((a, b) => {
        if (a.isDirectory === b.isDirectory) {
          return a.name.localeCompare(b.name);
        }
        return a.isDirectory ? -1 : 1;
      });

    return {
      entries: files,
      parent: path.dirname(target) !== target ? path.dirname(target) : undefined,
      current: target
    };
  }

  createRun({
    mode = "AUTO",
    globalMode = "IMPLEMENTATION",
    cwd
  }: { mode?: OrchestrationMode; globalMode?: GlobalMode; cwd?: string }): RunState {
    const now = nowIso();
    const runState: RunState = {
      id: newId(),
      contractVersion: "1",
      status: "running",
      mode,
      globalMode,
      cwd: cwd ?? this.repoRoot,
      createdAt: now,
      updatedAt: now,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      nodes: {},
      edges: {},
      artifacts: {}
    };
    this.store.createRun(runState);
    this.artifactStores.set(runState.id, new ArtifactStore(this.dataDir, runState.id));
    this.emitEvent(runState.id, {
      id: newId(),
      runId: runState.id,
      ts: now,
      type: "run.patch",
      patch: runState
    });
    this.emitEvent(runState.id, {
      id: newId(),
      runId: runState.id,
      ts: now,
      type: "run.mode",
      mode: runState.mode,
      globalMode: runState.globalMode
    });
    return runState;
  }

  createNode(runId: UUID, config: NodeConfigInput): NodeState {
    const record = this.requireRun(runId);
    const now = nowIso();
    const normalized = this.normalizeNodeConfig(config);
    const nodeId = normalized.id ?? newId();
    if (normalized.alias) {
      this.assertAliasAvailable(record, normalized.alias, nodeId);
    }
    const nodeState: NodeState = {
      id: nodeId,
      runId,
      label: normalized.label,
      alias: normalized.alias,
      roleTemplate: normalized.roleTemplate,
      customSystemPrompt: normalized.customSystemPrompt ?? null,
      provider: normalized.provider,
      status: "idle",
      summary: "idle",
      lastActivityAt: now,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      capabilities: normalized.capabilities,
      permissions: normalized.permissions,
      session: {
        sessionId: "pending",
        resetCommands: normalized.session.resetCommands
      },
      connection: {
        status: "idle",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      },
      inboxCount: 0
    };
    this.store.addNode(runId, nodeState, normalized);
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId: nodeState.id,
      patch: nodeState
    });
    return nodeState;
  }

  private async spawnNodeFromTool(
    runId: UUID,
    fromNodeId: UUID,
    request: SpawnNodeRequest
  ): Promise<SpawnNodeResult> {
    const record = this.requireRun(runId);
    const caller = this.requireNode(record, fromNodeId);
    this.ensureEdgeManagementForSpawn(caller);
    const { instructions, input, ...config } = request;
    const node = this.createNode(runId, config);
    const message = typeof instructions === "string" ? instructions.trim() : "";
    if (message || input) {
      const now = nowIso();
      const payload = input ? { message: message || "Spawned task", structured: input } : { message: message || "Spawned task" };
      const envelope: Envelope = {
        kind: "handoff",
        id: newId(),
        fromNodeId,
        toNodeId: node.id,
        createdAt: now,
        payload
      };
      this.deliverEnvelope(runId, envelope);
    }
    return {
      nodeId: node.id,
      label: node.label,
      alias: node.alias,
      roleTemplate: node.roleTemplate,
      provider: node.provider
    };
  }

  private async createEdgeFromTool(
    runId: UUID,
    fromNodeId: UUID,
    request: CreateEdgeRequest
  ): Promise<CreateEdgeResult> {
    const record = this.requireRun(runId);
    const caller = this.requireNode(record, fromNodeId);
    const missingNodes: string[] = [];
    const fromResolved = this.resolveNodeRef(record, request.from);
    const toResolved = this.resolveNodeRef(record, request.to);
    if (!fromResolved) {
      missingNodes.push(`from=${request.from}`);
    }
    if (!toResolved) {
      missingNodes.push(`to=${request.to}`);
    }
    if (missingNodes.length > 0) {
      throw new Error(
        `create_edge requires known node ids or aliases (${missingNodes.join(
          ", "
        )}). Use Task Payload Known nodes (id or alias).`
      );
    }
    const resolvedFrom = fromResolved ?? request.from;
    const resolvedTo = toResolved ?? request.to;
    this.ensureEdgeManagementForCreateEdge(caller, resolvedFrom, resolvedTo);
    const type = request.type ?? "handoff";
    const label = request.label ?? (type === "report" ? "report" : "task");
    const edge = this.createEdge(runId, {
      from: resolvedFrom,
      to: resolvedTo,
      bidirectional: request.bidirectional ?? true,
      type,
      label
    });
    return {
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      bidirectional: edge.bidirectional,
      type: edge.type,
      label: edge.label
    };
  }

  private async sendHandoffFromTool(
    runId: UUID,
    fromNodeId: UUID,
    request: SendHandoffRequest
  ): Promise<SendHandoffResult> {
    const record = this.requireRun(runId);
    const missingNodes: string[] = [];
    if (!record.nodes.has(fromNodeId)) {
      missingNodes.push(`from=${fromNodeId}`);
    }
    const toResolved = this.resolveNodeRef(record, request.to);
    if (!toResolved) {
      missingNodes.push(`to=${request.to}`);
    }
    if (missingNodes.length > 0) {
      throw new Error(
        `send_handoff requires known node ids or aliases (${missingNodes.join(
          ", "
        )}). Use Task Payload Known nodes (id or alias).`
      );
    }
    const resolvedTo = toResolved ?? request.to;
    if (!this.hasEdgeBetween(record, fromNodeId, resolvedTo)) {
      throw new Error(
        `send_handoff requires an edge between ${fromNodeId} and ${resolvedTo}. Create the edge first.`
      );
    }
    const now = nowIso();
    const payload: Envelope["payload"] = { message: request.message.trim() };
    if (request.structured) {
      payload.structured = request.structured;
    }
    if (request.artifacts && request.artifacts.length > 0) {
      payload.artifacts = request.artifacts;
    }
    if (request.status) {
      payload.status = request.status;
    }
    if (request.response) {
      payload.response = request.response;
    }
    const envelope: Envelope = {
      kind: "handoff",
      id: newId(),
      fromNodeId,
      toNodeId: resolvedTo,
      createdAt: now,
      payload
    };
    if (request.contextRef) {
      envelope.contextRef = request.contextRef;
    }
    this.deliverEnvelope(runId, envelope);
    return { envelopeId: envelope.id, from: fromNodeId, to: resolvedTo };
  }

  private hasEdgeBetween(record: RunRecord, from: UUID, to: UUID): boolean {
    for (const edge of record.edges.values()) {
      if (edge.from === from && edge.to === to) {
        return true;
      }
      if (edge.bidirectional && edge.from === to && edge.to === from) {
        return true;
      }
    }
    return false;
  }

  updateNode(runId: UUID, nodeId: UUID, patch: Partial<NodeState>, config?: Partial<NodeConfig>): NodeState {
    const record = this.requireRun(runId);
    const now = nowIso();
    const nodeRecord = this.requireNode(record, nodeId);
    let updatedPatch = { ...patch };
    let configPatch = config;

    const aliasInput =
      typeof patch.alias === "string" ? patch.alias : typeof config?.alias === "string" ? config.alias : undefined;
    if (aliasInput !== undefined) {
      const normalizedAlias = this.normalizeAlias(aliasInput);
      if (normalizedAlias) {
        this.assertAliasAvailable(record, normalizedAlias, nodeId);
      }
      updatedPatch = { ...updatedPatch, alias: normalizedAlias };
      configPatch = { ...(configPatch ?? {}), alias: normalizedAlias };
    }

    if (config?.provider && config.provider !== nodeRecord.config.provider) {
      if (this.runner.disposeNode) {
        if (nodeRecord.state.status === "running") {
          nodeRecord.runtime.cancelRequested = true;
        }
        void this.runner.disposeNode(nodeId);
      }
      if (updatedPatch.provider === undefined) {
        updatedPatch = { ...updatedPatch, provider: config.provider };
      }
      const disconnected: NodeConnection = {
        status: "disconnected",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      };
      updatedPatch = {
        ...updatedPatch,
        connection: nodeRecord.state.connection
          ? { ...nodeRecord.state.connection, ...disconnected }
          : disconnected
      };
    }

    const updated = this.store.updateNode(runId, nodeId, updatedPatch);
    if (configPatch) {
      this.store.updateNodeConfig(runId, nodeId, configPatch);
    }
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId,
      patch: updatedPatch
    });
    return updated;
  }

  createEdge(runId: UUID, edge: Omit<EdgeState, "id"> & { id?: UUID }): EdgeState {
    const record = this.requireRun(runId);
    const now = nowIso();
    const resolved: EdgeState = {
      id: edge.id ?? newId(),
      from: edge.from,
      to: edge.to,
      bidirectional: edge.bidirectional ?? true,
      type: edge.type ?? "handoff",
      label: edge.label ?? ((edge.type ?? "handoff") === "report" ? "report" : "task")
    };
    this.store.addEdge(runId, resolved);
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "edge.created",
      edge: resolved
    });
    return resolved;
  }

  deleteEdge(runId: UUID, edgeId: UUID): void {
    const record = this.requireRun(runId);
    const now = nowIso();
    this.store.deleteEdge(runId, edgeId);
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "edge.deleted",
      edgeId
    });
  }

  postMessage(runId: UUID, nodeId: UUID, content: string, interrupt = false): UserMessageRecord {
    const record = this.requireRun(runId);
    const now = nowIso();
    const message: UserMessageRecord = {
      id: newId(),
      runId,
      nodeId,
      role: "user",
      content,
      interrupt,
      createdAt: now
    };
    this.store.enqueueMessage(runId, nodeId, message, interrupt);
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "message.user",
      message
    });
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId,
      patch: { inboxCount: this.requireNode(record, nodeId).state.inboxCount }
    });
    return message;
  }

  listApprovals(): Array<{ runId: UUID; approval: ApprovalRequest }> {
    return this.store.listApprovals();
  }

  resolveApproval(runId: UUID, approvalId: UUID, resolution: ApprovalResolution): void {
    const record = this.requireRun(runId);
    const now = nowIso();
    const approval = this.store.resolveApproval(runId, approvalId);
    if (!approval) {
      return;
    }
    const resolver = this.runner.resolveApproval?.(approvalId, resolution);
    if (resolver) {
      resolver.catch((error) => {
        this.logger.error("failed to forward approval resolution", {
          approvalId,
          runId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "approval.resolved",
      approvalId,
      resolution
    });
    this.unblockNode(record, approval.nodeId, now);
  }

  resolveApprovalById(approvalId: UUID, resolution: ApprovalResolution): void {
    const now = nowIso();
    const resolved = this.store.resolveApprovalById(approvalId);
    if (!resolved) {
      return;
    }
    const resolver = this.runner.resolveApproval?.(approvalId, resolution);
    if (resolver) {
      resolver.catch((error) => {
        this.logger.error("failed to forward approval resolution", {
          approvalId,
          runId: resolved.runId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
    this.emitEvent(resolved.runId, {
      id: newId(),
      runId: resolved.runId,
      ts: now,
      type: "approval.resolved",
      approvalId,
      resolution
    });
    const record = this.requireRun(resolved.runId);
    this.unblockNode(record, resolved.approval.nodeId, now);
  }

  async recordArtifact(
    runId: UUID,
    nodeId: UUID,
    kind: ArtifactKind,
    name: string,
    content: string,
    metadata?: ArtifactMetadata
  ): Promise<Artifact> {
    const record = this.requireRun(runId);
    const now = nowIso();
    const store = this.requireArtifactStore(runId);
    const artifactId = newId();
    const filename = `${artifactId}-${name}`;
    const path = await store.writeArtifact(filename, content);
    const artifact: Artifact = {
      id: artifactId,
      runId,
      nodeId,
      kind,
      name,
      path,
      createdAt: now,
      metadata
    };
    this.store.addArtifact(runId, artifact);
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "artifact.created",
      artifact
    });
    return artifact;
  }

  deliverEnvelope(runId: UUID, envelope: Envelope): void {
    const record = this.requireRun(runId);
    const now = nowIso();
    this.store.enqueueEnvelope(runId, envelope.toNodeId, envelope);
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "handoff.sent",
      envelope
    });
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId: envelope.toNodeId,
      patch: { inboxCount: this.requireNode(record, envelope.toNodeId).state.inboxCount }
    });
  }

  emitEvent(runId: UUID, event: EventEnvelope): void {
    const record = this.requireRun(runId);
    let usagePatch: { nodeId?: UUID; nodeUsage?: UsageTotals; runUsage?: UsageTotals; ts: string } | null = null;

    if (event.type === "telemetry.usage") {
      const timestamp = event.ts ?? nowIso();
      const runUsage = addUsage(record.state.usage, event.usage);
      record.state.usage = runUsage;
      record.state.updatedAt = timestamp;

      let nodeUsage: UsageTotals | undefined;
      if (event.nodeId) {
        const nodeRecord = record.nodes.get(event.nodeId);
        if (nodeRecord) {
          nodeUsage = addUsage(nodeRecord.state.usage, event.usage);
          nodeRecord.state = { ...nodeRecord.state, usage: nodeUsage };
          record.state.nodes[event.nodeId] = nodeRecord.state;
        }
      }

      usagePatch = {
        nodeId: event.nodeId,
        nodeUsage,
        runUsage,
        ts: timestamp
      };
    }
    if (event.type === "node.patch") {
      const nodeRecord = record.nodes.get(event.nodeId);
      if (nodeRecord) {
        nodeRecord.state = { ...nodeRecord.state, ...event.patch };
        record.state.nodes[event.nodeId] = nodeRecord.state;
        record.state.updatedAt = event.ts ?? nowIso();
      }
    }
    void record.eventLog.append(event);
    this.eventBus.emit(event);

    if (usagePatch?.nodeId && usagePatch.nodeUsage) {
      this.emitEvent(runId, {
        id: newId(),
        runId,
        ts: usagePatch.ts,
        type: "node.patch",
        nodeId: usagePatch.nodeId,
        patch: { usage: usagePatch.nodeUsage }
      });
    }

    if (usagePatch?.runUsage) {
      this.emitEvent(runId, {
        id: newId(),
        runId,
        ts: usagePatch.ts,
        type: "run.patch",
        patch: { usage: usagePatch.runUsage, updatedAt: usagePatch.ts }
      });
    }
  }

  private touchRun(record: RunRecord, timestamp: string): void {
    record.state.updatedAt = timestamp;
  }

  private normalizeNodeConfig(config: NodeConfigInput): NodeConfig {
    const isOrchestrator = config.roleTemplate.trim().toLowerCase() === "orchestrator";
    return {
      id: config.id,
      label: config.label,
      alias: this.normalizeAlias(config.alias),
      provider: config.provider,
      roleTemplate: config.roleTemplate,
      customSystemPrompt: config.customSystemPrompt ?? null,
      capabilities: {
        edgeManagement: this.resolveEdgeManagement(config.capabilities?.edgeManagement, isOrchestrator),
        writeCode: config.capabilities?.writeCode ?? true,
        writeDocs: config.capabilities?.writeDocs ?? true,
        runCommands: config.capabilities?.runCommands ?? true,
        delegateOnly: config.capabilities?.delegateOnly ?? false
      },
      permissions: {
        cliPermissionsMode: config.permissions?.cliPermissionsMode ?? "skip",
        agentManagementRequiresApproval:
          config.permissions?.agentManagementRequiresApproval ?? !isOrchestrator
      },
      session: {
        resume: config.session?.resume ?? true,
        resetCommands: config.session?.resetCommands ?? ["/new", "/clear"]
      }
    };
  }

  private resolveEdgeManagement(
    value: EdgeManagementScope | undefined,
    isOrchestrator: boolean
  ): EdgeManagementScope {
    if (value === "none" || value === "self" || value === "all") {
      return value;
    }
    return isOrchestrator ? "all" : "none";
  }

  private ensureEdgeManagementForSpawn(nodeRecord: NodeRecord): void {
    const scope = nodeRecord.state.capabilities.edgeManagement;
    if (scope === "all") {
      return;
    }
    this.logger.warn("spawn_node blocked by edgeManagement", {
      nodeId: nodeRecord.state.id,
      label: nodeRecord.state.label,
      edgeManagement: scope
    });
    throw new Error("edgeManagement=all required to spawn nodes");
  }

  private ensureEdgeManagementForCreateEdge(nodeRecord: NodeRecord, from: UUID, to: UUID): void {
    const scope = nodeRecord.state.capabilities.edgeManagement;
    if (scope === "all") {
      return;
    }
    if (scope === "none") {
      this.logger.warn("create_edge blocked by edgeManagement", {
        nodeId: nodeRecord.state.id,
        label: nodeRecord.state.label,
        edgeManagement: scope,
        from,
        to
      });
      throw new Error("edgeManagement capability is disabled");
    }
    if (from !== nodeRecord.state.id && to !== nodeRecord.state.id) {
      this.logger.warn("create_edge blocked by edgeManagement=self", {
        nodeId: nodeRecord.state.id,
        label: nodeRecord.state.label,
        edgeManagement: scope,
        from,
        to
      });
      throw new Error("edgeManagement=self only allows edges that include the calling node");
    }
  }

  private normalizeAlias(value?: string | null): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private assertAliasAvailable(record: RunRecord, alias: string, nodeId?: UUID): void {
    const normalized = alias.toLowerCase();
    if (nodeId && nodeId.toLowerCase() === normalized) {
      this.logger.warn("node alias conflicts with node id", { alias, nodeId });
      throw new Error(`alias "${alias}" conflicts with node id ${nodeId}`);
    }
    for (const node of record.nodes.values()) {
      if (nodeId && node.state.id === nodeId) {
        continue;
      }
      if (node.state.id.toLowerCase() === normalized) {
        this.logger.warn("node alias conflicts with existing node id", {
          alias,
          nodeId: node.state.id
        });
        throw new Error(`alias "${alias}" conflicts with node id ${node.state.id}`);
      }
      const existingAlias = node.state.alias;
      if (existingAlias && existingAlias.toLowerCase() === normalized) {
        this.logger.warn("node alias already in use", {
          alias,
          nodeId: node.state.id,
          label: node.state.label
        });
        throw new Error(`alias "${alias}" is already in use by ${node.state.label} (${node.state.id})`);
      }
    }
  }

  private resolveNodeRef(record: RunRecord, ref: string): UUID | null {
    const trimmed = ref.trim();
    if (!trimmed) {
      return null;
    }
    if (record.nodes.has(trimmed)) {
      return trimmed;
    }
    const target = trimmed.toLowerCase();
    for (const node of record.nodes.values()) {
      const alias = node.state.alias;
      if (alias && alias.toLowerCase() === target) {
        return node.state.id;
      }
    }
    return null;
  }

  private requireRun(runId: UUID): RunRecord {
    const record = this.store.getRun(runId);
    if (!record) {
      throw new Error(`Run ${runId} not found`);
    }
    return record;
  }

  private requireNode(record: RunRecord, nodeId: UUID): NodeRecord {
    const nodeRecord = record.nodes.get(nodeId);
    if (!nodeRecord) {
      throw new Error(`Node ${nodeId} not found`);
    }
    return nodeRecord;
  }

  private requireArtifactStore(runId: UUID): ArtifactStore {
    const store = this.artifactStores.get(runId);
    if (!store) {
      const newStore = new ArtifactStore(this.dataDir, runId);
      this.artifactStores.set(runId, newStore);
      return newStore;
    }
    return store;
  }

  private unblockNode(record: RunRecord, nodeId: UUID, now: string): void {
    const nodeRecord = record.nodes.get(nodeId);
    if (!nodeRecord) {
      return;
    }
    nodeRecord.runtime.pendingTurn = true;
    nodeRecord.state.status = "idle";
    nodeRecord.state.summary = "approval resolved";
    nodeRecord.state.lastActivityAt = now;
    record.state.nodes[nodeId] = nodeRecord.state;
    record.state.updatedAt = now;
    this.emitEvent(record.state.id, {
      id: newId(),
      runId: record.state.id,
      ts: now,
      type: "node.patch",
      nodeId,
      patch: {
        status: "idle",
        summary: "approval resolved",
        lastActivityAt: now
      }
    });
    this.emitEvent(record.state.id, {
      id: newId(),
      runId: record.state.id,
      ts: now,
      type: "node.progress",
      nodeId,
      status: "idle",
      summary: "approval resolved"
    });
  }

  private interruptRun(record: RunRecord, now: string): void {
    for (const nodeRecord of record.nodes.values()) {
      const nodeId = nodeRecord.state.id;
      const wasRunning = nodeRecord.state.status === "running";
      nodeRecord.runtime.pendingTurn = false;
      nodeRecord.runtime.wasInterrupted = wasRunning;
      const connection: NodeConnection | undefined = nodeRecord.state.connection
        ? {
          ...nodeRecord.state.connection,
          status: "idle",
          streaming: false,
          lastHeartbeatAt: now,
          lastOutputAt: now
        }
        : undefined;
      const summary = wasRunning ? "interrupted" : "paused";
      nodeRecord.state = {
        ...nodeRecord.state,
        status: "idle",
        summary,
        lastActivityAt: now,
        connection
      };
      record.state.nodes[nodeId] = nodeRecord.state;
      this.emitEvent(record.state.id, {
        id: newId(),
        runId: record.state.id,
        ts: now,
        type: "node.patch",
        nodeId,
        patch: {
          status: "idle",
          summary,
          lastActivityAt: now,
          connection
        }
      });
      if (wasRunning && this.runner.interruptNode) {
        this.runner.interruptNode(nodeId).catch((error) => {
          this.logger.error("failed to interrupt node session", {
            nodeId,
            runId: record.state.id,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }
  }

  private resumeInterruptedNodes(record: RunRecord): void {
    for (const nodeRecord of record.nodes.values()) {
      const nodeId = nodeRecord.state.id;
      if (!nodeRecord.runtime.wasInterrupted) {
        continue;
      }
      nodeRecord.runtime.wasInterrupted = false;
      this.postMessage(record.state.id, nodeId, "Continue.", true);
    }
  }

  private stopRun(record: RunRecord, now: string): void {
    for (const nodeRecord of record.nodes.values()) {
      const nodeId = nodeRecord.state.id;
      nodeRecord.runtime.pendingTurn = false;
      nodeRecord.runtime.wasInterrupted = false;
      const connection: NodeConnection | undefined = nodeRecord.state.connection
        ? {
          ...nodeRecord.state.connection,
          status: "disconnected",
          streaming: false,
          lastHeartbeatAt: now,
          lastOutputAt: now
        }
        : undefined;
      nodeRecord.state = {
        ...nodeRecord.state,
        status: "idle",
        summary: "stopped",
        lastActivityAt: now,
        connection
      };
      record.state.nodes[nodeId] = nodeRecord.state;
      this.emitEvent(record.state.id, {
        id: newId(),
        runId: record.state.id,
        ts: now,
        type: "node.patch",
        nodeId,
        patch: {
          status: "idle",
          summary: "stopped",
          lastActivityAt: now,
          connection
        }
      });
      if (this.runner.stopNode) {
        this.runner.stopNode(nodeId).catch((error) => {
          this.logger.error("failed to stop node session", {
            nodeId,
            runId: record.state.id,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }
  }
}
