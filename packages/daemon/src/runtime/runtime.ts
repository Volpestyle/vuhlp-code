import { promises as fs } from "fs";
import path from "path";
import type {
  ApprovalRequest,
  ApprovalResolution,
  Artifact,
  ArtifactKind,
  ArtifactMetadata,
  EdgeState,
  Envelope,
  EventEnvelope,
  GlobalMode,
  NodeConfig,
  NodeConfigInput,
  NodeState,
  OrchestrationMode,
  RunState,
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

export interface RuntimeOptions {
  dataDir: string;
  runner?: NodeRunner;
  stallThreshold?: number;
  repoRoot?: string;
}

export class Runtime {
  private readonly store: RunStore;
  private readonly eventBus: EventBus;
  private readonly scheduler: Scheduler;
  private readonly runner: NodeRunner;
  private readonly dataDir: string;
  private readonly artifactStores = new Map<UUID, ArtifactStore>();

  constructor(options: RuntimeOptions) {
    this.dataDir = options.dataDir;
    this.store = new RunStore(this.dataDir);
    this.eventBus = new EventBus();
    this.runner =
      options.runner ??
      new CliRunner({
        repoRoot: options.repoRoot ?? process.cwd(),
        emitEvent: this.emitEvent.bind(this)
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
      this.interruptRun(record, now, "paused");
    }

    return record.state;
  }

  async deleteRun(runId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const now = nowIso();

    if (this.runner.closeNode) {
      for (const nodeRecord of record.nodes.values()) {
        nodeRecord.runtime.cancelRequested = true;
        try {
          await this.runner.closeNode(nodeRecord.state.id);
        } catch (error) {
          console.error("failed to close node session", {
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
      console.error("failed to remove run data", {
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
    if (this.runner.resetNode) {
      try {
        await this.runner.resetNode(nodeId);
      } catch (error) {
        console.error("failed to reset node session", {
          nodeId,
          runId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const idleConnection = nodeRecord.state.connection
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

  async deleteNode(runId: UUID, nodeId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const now = nowIso();
    const nodeRecord = record.nodes.get(nodeId);
    if (!nodeRecord) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (this.runner.closeNode) {
      nodeRecord.runtime.cancelRequested = true;
      try {
        await this.runner.closeNode(nodeId);
      } catch (error) {
        console.error("failed to close node session", {
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

  createRun({
    mode = "AUTO",
    globalMode = "IMPLEMENTATION"
  }: { mode?: OrchestrationMode; globalMode?: GlobalMode }): RunState {
    const now = nowIso();
    const runState: RunState = {
      id: newId(),
      contractVersion: "1",
      status: "running",
      mode,
      globalMode,
      createdAt: now,
      updatedAt: now,
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
    const nodeState: NodeState = {
      id: normalized.id ?? newId(),
      runId,
      label: normalized.label,
      roleTemplate: normalized.roleTemplate,
      customSystemPrompt: normalized.customSystemPrompt ?? null,
      provider: normalized.provider,
      status: "idle",
      summary: "idle",
      lastActivityAt: now,
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

  updateNode(runId: UUID, nodeId: UUID, patch: Partial<NodeState>, config?: Partial<NodeConfig>): NodeState {
    const record = this.requireRun(runId);
    const now = nowIso();
    const nodeRecord = this.requireNode(record, nodeId);
    let updatedPatch = { ...patch };

    if (config?.provider && config.provider !== nodeRecord.config.provider) {
      if (this.runner.closeNode) {
        if (nodeRecord.state.status === "running") {
          nodeRecord.runtime.cancelRequested = true;
        }
        void this.runner.closeNode(nodeId);
      }
      if (updatedPatch.provider === undefined) {
        updatedPatch = { ...updatedPatch, provider: config.provider };
      }
      const disconnected = {
        status: "disconnected" as const,
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
    if (config) {
      this.store.updateNodeConfig(runId, nodeId, config);
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
        console.error("failed to forward approval resolution", {
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
        console.error("failed to forward approval resolution", {
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
    void record.eventLog.append(event);
    this.eventBus.emit(event);
  }

  private touchRun(record: RunRecord, timestamp: string): void {
    record.state.updatedAt = timestamp;
  }

  private normalizeNodeConfig(config: NodeConfigInput): NodeConfig {
    return {
      id: config.id,
      label: config.label,
      provider: config.provider,
      roleTemplate: config.roleTemplate,
      customSystemPrompt: config.customSystemPrompt ?? null,
      capabilities: {
        spawnNodes: config.capabilities?.spawnNodes ?? false,
        writeCode: config.capabilities?.writeCode ?? true,
        writeDocs: config.capabilities?.writeDocs ?? true,
        runCommands: config.capabilities?.runCommands ?? true,
        delegateOnly: config.capabilities?.delegateOnly ?? false
      },
      permissions: {
        cliPermissionsMode: config.permissions?.cliPermissionsMode ?? "skip",
        spawnRequiresApproval: config.permissions?.spawnRequiresApproval ?? true
      },
      session: {
        resume: config.session?.resume ?? true,
        resetCommands: config.session?.resetCommands ?? ["/new", "/clear"]
      }
    };
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

  private interruptRun(record: RunRecord, now: string, summary: string): void {
    for (const nodeRecord of record.nodes.values()) {
      const nodeId = nodeRecord.state.id;
      nodeRecord.runtime.pendingTurn = false;
      const connection = nodeRecord.state.connection
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
      if (this.runner.closeNode) {
        this.runner.closeNode(nodeId).catch((error) => {
          console.error("failed to close node session", {
            nodeId,
            runId: record.state.id,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }
  }
}
