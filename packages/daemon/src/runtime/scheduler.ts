import type {
  Artifact,
  ArtifactMetadata,
  Envelope,
  EventEnvelope,
  NodeConnection,
  NodeState,
  PromptArtifacts,
  UserMessageRecord,
  UUID
} from "@vuhlp/contracts";
import { ConsoleLogger, type Logger } from "@vuhlp/providers";
import type { NodeRunner, TurnResult } from "./runner.js";
import type { NodeRecord, RunRecord, RunStore } from "./store.js";
import { updateStallState } from "./loop-safety.js";
import { hashString, newId, nowIso } from "./utils.js";
import { ArtifactStore } from "./artifact-store.js";

export interface SchedulerOptions {
  store: RunStore;
  emitEvent: (runId: UUID, event: EventEnvelope) => void;
  runner: NodeRunner;
  dataDir: string;
  stallThreshold?: number;
  logger?: Logger;
}

export class Scheduler {
  private readonly store: RunStore;
  private readonly emitEvent: (runId: UUID, event: EventEnvelope) => void;
  private readonly runner: NodeRunner;
  private readonly dataDir: string;
  private readonly stallThreshold: number;
  private readonly logger: Logger;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private artifactStores = new Map<UUID, ArtifactStore>();

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.emitEvent = options.emitEvent;
    this.runner = options.runner;
    this.dataDir = options.dataDir;
    this.stallThreshold = options.stallThreshold ?? 2;
    this.logger = options.logger ?? new ConsoleLogger({ scope: "scheduler" });
  }

  start(intervalMs = 250): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const runs = this.store.listRuns();
      for (const runState of runs) {
        if (runState.status !== "running") {
          continue;
        }
        const record = this.store.getRun(runState.id);
        if (!record) {
          continue;
        }
        for (const nodeRecord of record.nodes.values()) {
          if (!this.isRunnable(nodeRecord)) {
            continue;
          }
          await this.runNodeTurn(record, nodeRecord);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private isRunnable(nodeRecord: NodeRecord): boolean {
    if (nodeRecord.state.status !== "idle") {
      return false;
    }
    if (nodeRecord.state.connection?.status === "disconnected") {
      return false;
    }
    return (
      nodeRecord.runtime.inbox.length > 0 ||
      nodeRecord.runtime.queuedMessages.length > 0 ||
      nodeRecord.runtime.pendingTurn ||
      nodeRecord.runtime.autoPromptQueued
    );
  }

  private async runNodeTurn(record: RunRecord, nodeRecord: NodeRecord): Promise<void> {
    const runId = record.state.id;
    const nodeId = nodeRecord.state.id;
    const now = nowIso();
    const runningConnection: NodeConnection | undefined = nodeRecord.state.connection
      ? {
        ...nodeRecord.state.connection,
        status: "connected",
        streaming: true,
        lastHeartbeatAt: now
      }
      : undefined;
    this.patchNode(record, nodeRecord, {
      status: "running",
      summary: "running",
      lastActivityAt: now,
      connection: runningConnection
    });
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.progress",
      nodeId,
      status: "running",
      summary: "running"
    });

    const resumePending = nodeRecord.runtime.pendingTurn;
    const hasQueuedInputs =
      nodeRecord.runtime.inbox.length > 0 || nodeRecord.runtime.queuedMessages.length > 0;
    const autoQueued = nodeRecord.runtime.autoPromptQueued;
    let envelopes: Envelope[] = [];
    let messages: UserMessageRecord[] = [];
    if (resumePending) {
      nodeRecord.runtime.autoPromptQueued = false;
    } else if (autoQueued && !hasQueuedInputs) {
      nodeRecord.runtime.autoPromptQueued = false;
    } else {
      nodeRecord.runtime.autoPromptQueued = false;
      const consumed = this.store.consumeInbox(nodeRecord);
      envelopes = consumed.envelopes;
      messages = consumed.messages;
      this.patchNode(record, nodeRecord, { inboxCount: 0 });
    }

    let result: TurnResult;
    try {
      result = await this.runner.runTurn({
        run: record.state,
        node: nodeRecord.state,
        config: nodeRecord.config,
        envelopes,
        messages
      });
    } catch (error) {
      result = {
        kind: "failed",
        summary: "Provider error",
        error: error instanceof Error ? error.message : String(error)
      };
    }

    if (!record.nodes.has(nodeId)) {
      return;
    }

    if (result.kind === "interrupted") {
      await this.handleInterrupted(record, nodeRecord, result);
      return;
    }

    if (record.state.status !== "running") {
      const pausedAt = nowIso();
      const summary =
        record.state.status === "paused"
          ? "paused"
          : record.state.status === "stopped"
            ? "stopped"
            : "interrupted";
      const idleConnection: NodeConnection | undefined = nodeRecord.state.connection
        ? {
          ...nodeRecord.state.connection,
          streaming: false,
          lastHeartbeatAt: pausedAt,
          lastOutputAt: pausedAt
        }
        : undefined;
      this.patchNode(record, nodeRecord, {
        status: "idle",
        summary,
        lastActivityAt: pausedAt,
        connection: idleConnection
      });
      return;
    }

    if (nodeRecord.runtime.cancelRequested) {
      nodeRecord.runtime.cancelRequested = false;
      const interruptedAt = nowIso();
      const idleConnection: NodeConnection | undefined = nodeRecord.state.connection
        ? {
          ...nodeRecord.state.connection,
          streaming: false,
          lastHeartbeatAt: interruptedAt,
          lastOutputAt: interruptedAt
        }
        : undefined;
      this.patchNode(record, nodeRecord, {
        status: "idle",
        summary: "interrupted",
        lastActivityAt: interruptedAt,
        connection: idleConnection
      });
      return;
    }

    const promptArtifacts = await this.recordPromptArtifacts(record, runId, nodeId, result.prompt);

    if (result.kind === "blocked") {
      this.handleBlocked(record, nodeRecord, result);
      return;
    }

    if (result.kind === "failed") {
      this.handleFailed(record, nodeRecord, result);
      return;
    }

    await this.handleCompleted(record, nodeRecord, result, promptArtifacts);
  }

  private handleBlocked(record: RunRecord, nodeRecord: NodeRecord, result: Extract<TurnResult, { kind: "blocked" }>): void {
    const runId = record.state.id;
    const nodeId = nodeRecord.state.id;
    const now = nowIso();
    record.approvals.set(result.approval.approvalId, result.approval);
    nodeRecord.runtime.pendingTurn = true;
    const blockedConnection: NodeConnection | undefined = nodeRecord.state.connection
      ? {
        ...nodeRecord.state.connection,
        status: "idle",
        streaming: false,
        lastOutputAt: now
      }
      : undefined;
    this.patchNode(record, nodeRecord, {
      status: "blocked",
      summary: result.summary,
      lastActivityAt: now,
      connection: blockedConnection
    });
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "approval.requested",
      approvalId: result.approval.approvalId,
      nodeId,
      tool: result.approval.tool,
      context: result.approval.context
    });
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.progress",
      nodeId,
      status: "blocked",
      summary: result.summary
    });
  }

  private handleFailed(record: RunRecord, nodeRecord: NodeRecord, result: Extract<TurnResult, { kind: "failed" }>): void {
    const runId = record.state.id;
    const nodeId = nodeRecord.state.id;
    const now = nowIso();
    nodeRecord.runtime.pendingTurn = false;
    const failedConnection: NodeConnection | undefined = nodeRecord.state.connection
      ? {
        ...nodeRecord.state.connection,
        status: "idle",
        streaming: false,
        lastOutputAt: now
      }
      : undefined;
    this.patchNode(record, nodeRecord, {
      status: "failed",
      summary: result.summary,
      lastActivityAt: now,
      connection: failedConnection
    });
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.progress",
      nodeId,
      status: "failed",
      summary: result.summary
    });
  }

  private async handleCompleted(
    record: RunRecord,
    nodeRecord: NodeRecord,
    result: Extract<TurnResult, { kind: "completed" }>,
    promptArtifacts: Artifact[]
  ): Promise<void> {
    const runId = record.state.id;
    const nodeId = nodeRecord.state.id;
    const now = nowIso();
    nodeRecord.runtime.pendingTurn = false;

    const artifacts: Artifact[] = [...promptArtifacts];

    if (result.artifacts) {
      for (const artifact of result.artifacts) {
        const stored = await this.recordArtifact(
          record,
          runId,
          nodeId,
          artifact.kind,
          artifact.name,
          artifact.content,
          artifact.metadata
        );
        artifacts.push(stored);
      }
    }

    const diffArtifact = await this.recordDiffArtifact(record, runId, nodeId, result.diff);
    if (diffArtifact) {
      artifacts.push(diffArtifact);
    }

    const outputHash = result.outputHash ?? hashString(result.message);
    const diffHash = result.diffHash ?? (result.diff?.content ? hashString(result.diff.content) : undefined);

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "message.assistant.final",
      nodeId,
      content: result.message
    });

    const stallCheck = updateStallState(
      nodeRecord.runtime,
      {
        outputHash,
        diffHash,
        verificationFailure: result.verificationFailure,
        summary: result.summary
      },
      this.stallThreshold
    );

    if (stallCheck.stalled && stallCheck.evidence) {
      record.state.status = "paused";
      record.state.updatedAt = now;
      this.emitEvent(runId, {
        id: newId(),
        runId,
        ts: now,
        type: "run.patch",
        patch: { status: "paused", updatedAt: now }
      });
      this.emitEvent(runId, {
        id: newId(),
        runId,
        ts: now,
        type: "run.stalled",
        evidence: stallCheck.evidence
      });
      const stalledConnection: NodeConnection | undefined = nodeRecord.state.connection
        ? {
          ...nodeRecord.state.connection,
          status: "idle",
          streaming: false,
          lastOutputAt: now
        }
        : undefined;
      this.patchNode(record, nodeRecord, {
        status: "blocked",
        summary: "stalled",
        lastActivityAt: now,
        connection: stalledConnection
      });
      return;
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
    this.patchNode(record, nodeRecord, {
      status: "idle",
      summary: result.summary,
      lastActivityAt: now,
      connection: idleConnection
    });

    const outgoing = result.outgoing ?? [];
    for (const envelope of outgoing) {
      this.store.enqueueEnvelope(runId, envelope.toNodeId, envelope);
      this.emitEvent(runId, {
        id: newId(),
        runId,
        ts: now,
        type: "handoff.sent",
        envelope
      });
      const target = record.nodes.get(envelope.toNodeId);
      if (target) {
        this.emitEvent(runId, {
          id: newId(),
          runId,
          ts: now,
          type: "node.patch",
          nodeId: envelope.toNodeId,
          patch: { inboxCount: target.state.inboxCount }
        });
      }
    }

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.progress",
      nodeId,
      status: "idle",
      summary: result.summary
    });

    this.queueAutoPrompt(record, nodeRecord);
  }

  private async handleInterrupted(
    record: RunRecord,
    nodeRecord: NodeRecord,
    result: Extract<TurnResult, { kind: "interrupted" }>
  ): Promise<void> {
    const runId = record.state.id;
    const nodeId = nodeRecord.state.id;
    const now = nowIso();
    nodeRecord.runtime.pendingTurn = false;

    await this.recordPromptArtifacts(record, runId, nodeId, result.prompt);

    if (result.message && result.message.trim().length > 0) {
      this.emitEvent(runId, {
        id: newId(),
        runId,
        ts: now,
        type: "message.assistant.final",
        nodeId,
        content: result.message,
        status: "interrupted"
      });
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
    this.patchNode(record, nodeRecord, {
      status: "idle",
      summary: result.summary,
      lastActivityAt: now,
      connection: idleConnection
    });
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.progress",
      nodeId,
      status: "idle",
      summary: result.summary
    });
  }

  private async recordDiffArtifact(
    record: RunRecord,
    runId: UUID,
    nodeId: UUID,
    diff?: { content: string; filesChanged?: string[]; summary?: string }
  ): Promise<Artifact | undefined> {
    if (!diff) {
      return undefined;
    }
    const content = diff.content;
    const metadata: ArtifactMetadata = { filesChanged: diff.filesChanged, summary: diff.summary };
    return this.recordArtifact(record, runId, nodeId, "diff", "diff.patch", content, metadata);
  }

  private async recordPromptArtifacts(
    record: RunRecord,
    runId: UUID,
    nodeId: UUID,
    prompt?: PromptArtifacts
  ): Promise<Artifact[]> {
    if (!prompt) {
      return [];
    }
    const promptFull = await this.recordArtifact(
      record,
      runId,
      nodeId,
      "prompt",
      "prompt.full.txt",
      prompt.full
    );
    const promptBlocks = await this.recordArtifact(
      record,
      runId,
      nodeId,
      "prompt",
      "prompt.blocks.json",
      JSON.stringify(prompt.blocks, null, 2)
    );
    return [promptFull, promptBlocks];
  }

  private async recordArtifact(
    record: RunRecord,
    runId: UUID,
    nodeId: UUID,
    kind: Artifact["kind"],
    name: string,
    content: string,
    metadata?: ArtifactMetadata
  ): Promise<Artifact> {
    const now = nowIso();
    const store = this.getArtifactStore(runId);
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
    record.state.updatedAt = now;
    this.store.addArtifact(runId, artifact);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "artifact.created",
      artifact
    });
    return artifact;
  }

  private queueAutoPrompt(record: RunRecord, nodeRecord: NodeRecord): void {
    if (!this.shouldAutoPrompt(record, nodeRecord)) {
      return;
    }
    nodeRecord.runtime.autoPromptQueued = true;
    this.logger.info("auto re-prompt queued", {
      runId: record.state.id,
      nodeId: nodeRecord.state.id,
      roleTemplate: nodeRecord.state.roleTemplate
    });
  }

  private shouldAutoPrompt(record: RunRecord, nodeRecord: NodeRecord): boolean {
    if (record.state.status !== "running" || record.state.mode !== "AUTO") {
      return false;
    }
    if (!this.isOrchestratorRole(nodeRecord.state.roleTemplate)) {
      return false;
    }
    if (nodeRecord.state.status !== "idle") {
      return false;
    }
    if (nodeRecord.runtime.pendingTurn || nodeRecord.runtime.autoPromptQueued) {
      return false;
    }
    if (nodeRecord.runtime.inbox.length > 0 || nodeRecord.runtime.queuedMessages.length > 0) {
      return false;
    }
    if (nodeRecord.state.connection?.status === "disconnected") {
      return false;
    }
    return true;
  }

  private isOrchestratorRole(roleTemplate: string): boolean {
    return roleTemplate.trim().toLowerCase() === "orchestrator";
  }

  private getArtifactStore(runId: UUID): ArtifactStore {
    const existing = this.artifactStores.get(runId);
    if (existing) {
      return existing;
    }
    const store = new ArtifactStore(this.dataDir, runId);
    this.artifactStores.set(runId, store);
    return store;
  }

  private patchNode(record: RunRecord, nodeRecord: NodeRecord, patch: Partial<NodeState>): void {
    nodeRecord.state = { ...nodeRecord.state, ...patch };
    record.state.nodes[nodeRecord.state.id] = nodeRecord.state;
    record.state.updatedAt = nowIso();
    this.emitEvent(record.state.id, {
      id: newId(),
      runId: record.state.id,
      ts: nowIso(),
      type: "node.patch",
      nodeId: nodeRecord.state.id,
      patch
    });
  }
}
