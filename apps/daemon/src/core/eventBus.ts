import { randomUUID } from "node:crypto";
import { RunStore } from "./store.js";
import {
  VuhlpEvent,
  RunEvent,
  NodeEvent,
  NodeDeletedEvent,
  EdgeEvent,
  EdgeDeletedEvent,
  ArtifactEvent,
  VerificationCompletedEvent,
  RunRecord,
  MessageUserEvent,
  MessageAssistantDeltaEvent,
  MessageAssistantFinalEvent,
  MessageReasoningEvent,
  ToolProposedEvent,
  ToolStartedEvent,
  ToolCompletedEvent,
  ToolProposal,
  ConsoleChunkEvent,
  ConsoleStream,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  ApprovalResolution,
  HandoffSentEvent,
  HandoffReportedEvent,
  ChatMessageSentEvent,
  ChatMessageQueuedEvent,
  InteractionModeChangedEvent,
  ChatMessageRecord,
  InteractionMode,
  RunMode,
  RunPhase,
  NodeControl,
  RunModeChangedEvent,
  RunPhaseChangedEvent,
  NodeControlChangedEvent,
  TurnStartedEvent,
  TurnCompletedEvent,
  PendingPrompt,
  PromptQueuedEvent,
  PromptSentEvent,
  PromptCancelledEvent,
} from "./types.js";
import { nowIso } from "./time.js";

type Subscriber = (event: VuhlpEvent) => void;

export class EventBus {
  private store: RunStore;
  private subscribers: Set<Subscriber> = new Set();

  constructor(store: RunStore) {
    this.store = store;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Publish an event, apply it to run state, persist, append to JSONL, and broadcast. */
  publish(event: VuhlpEvent): void {
    // Append first for durability
    this.store.appendEvent(event.runId, event);

    const run = this.store.getRun(event.runId);
    if (run) {
      this.applyToRun(run, event);
      this.store.persistRun(run);
    }

    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  // Convenience helpers

  emitRunPatch(runId: string, patch: Partial<RunRecord> & { id: string }, type: RunEvent["type"] = "run.updated"): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type,
      run: patch,
    } as RunEvent);
  }

  emitNodePatch(runId: string, nodeId: string, patch: NodeEvent["patch"], type: NodeEvent["type"]): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type,
      nodeId,
      patch,
    } as NodeEvent);
  }

  emitNodeProgress(runId: string, nodeId: string, message: string, raw?: unknown): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "node.progress",
      nodeId,
      message,
      raw,
    } as NodeEvent);
  }

  emitNodeDeleted(runId: string, nodeId: string): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "node.deleted",
      nodeId,
    } as NodeDeletedEvent);
  }

  emitEdge(runId: string, edge: EdgeEvent["edge"]): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "edge.created",
      edge,
    } as EdgeEvent);
  }

  emitEdgeDeleted(runId: string, edgeId: string): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "edge.deleted",
      edgeId,
    } as EdgeDeletedEvent);
  }

  emitArtifact(runId: string, artifact: ArtifactEvent["artifact"]): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "artifact.created",
      artifact,
    } as ArtifactEvent);
  }

  emitVerificationCompleted(runId: string, nodeId: string, report: VerificationCompletedEvent["report"]): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "verification.completed",
      nodeId,
      report,
    } as VerificationCompletedEvent);
  }

  // Message event helpers

  emitMessageUser(runId: string, nodeId: string, content: string): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "message.user",
      nodeId,
      content,
    } as MessageUserEvent);
  }

  emitMessageDelta(runId: string, nodeId: string, delta: string, index?: number): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "message.assistant.delta",
      nodeId,
      delta,
      index,
    } as MessageAssistantDeltaEvent);
  }

  emitMessageFinal(runId: string, nodeId: string, content: string, tokenCount?: number): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "message.assistant.final",
      nodeId,
      content,
      tokenCount,
    } as MessageAssistantFinalEvent);
  }

  emitMessageReasoning(runId: string, nodeId: string, content: string): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "message.reasoning",
      nodeId,
      content,
    } as MessageReasoningEvent);
  }

  // Tool event helpers

  emitToolProposed(runId: string, nodeId: string, tool: ToolProposal): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "tool.proposed",
      nodeId,
      tool,
    } as ToolProposedEvent);
  }

  emitToolStarted(runId: string, nodeId: string, toolId: string): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "tool.started",
      nodeId,
      toolId,
    } as ToolStartedEvent);
  }

  emitToolCompleted(
    runId: string,
    nodeId: string,
    toolId: string,
    result?: unknown,
    error?: { message: string; stack?: string },
    durationMs?: number
  ): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "tool.completed",
      nodeId,
      toolId,
      result,
      error,
      durationMs,
    } as ToolCompletedEvent);
  }

  // Console event helper

  emitConsoleChunk(runId: string, nodeId: string, stream: ConsoleStream, data: string): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "console.chunk",
      nodeId,
      stream,
      data,
      timestamp: nowIso(),
    } as ConsoleChunkEvent);
  }

  // Approval event helpers

  emitApprovalRequested(
    runId: string,
    nodeId: string,
    approvalId: string,
    tool: ToolProposal,
    context?: string,
    timeoutMs?: number
  ): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "approval.requested",
      nodeId,
      approvalId,
      tool,
      context,
      timeoutMs,
    } as ApprovalRequestedEvent);
  }

  emitApprovalResolved(
    runId: string,
    nodeId: string,
    approvalId: string,
    resolution: ApprovalResolution
  ): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "approval.resolved",
      nodeId,
      approvalId,
      resolution,
    } as ApprovalResolvedEvent);
  }

  // Handoff event helpers

  emitHandoffSent(
    runId: string,
    fromNodeId: string,
    toNodeId: string,
    edgeId: string,
    payload?: { promptPreview?: string; contextSources?: string[] }
  ): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "handoff.sent",
      fromNodeId,
      toNodeId,
      edgeId,
      payload,
    } as HandoffSentEvent);
  }

  emitHandoffReported(
    runId: string,
    fromNodeId: string,
    toNodeId: string,
    edgeId: string,
    payload?: { summaryPreview?: string; artifactCount?: number }
  ): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "handoff.reported",
      fromNodeId,
      toNodeId,
      edgeId,
      payload,
    } as HandoffReportedEvent);
  }

  // Chat event helpers

  emitChatMessageSent(
    runId: string,
    message: ChatMessageRecord,
    interrupted: boolean
  ): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "chat.message.sent",
      nodeId: message.nodeId,
      message,
      interrupted,
    } as ChatMessageSentEvent);
  }

  emitChatMessageQueued(runId: string, message: ChatMessageRecord): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "chat.message.queued",
      nodeId: message.nodeId,
      message,
    } as ChatMessageQueuedEvent);
  }

  emitInteractionModeChanged(
    runId: string,
    nodeId: string | undefined,
    mode: InteractionMode,
    previousMode: InteractionMode
  ): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "interaction.mode.changed",
      nodeId,
      mode,
      previousMode,
    } as InteractionModeChangedEvent);
  }

  // Run mode event helpers (AUTO/INTERACTIVE orchestration control)

  emitRunModeChanged(
    runId: string,
    mode: RunMode,
    previousMode: RunMode,
    reason?: string,
    turnsInProgress?: number
  ): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "run.mode.changed",
      mode,
      previousMode,
      reason,
      turnsInProgress,
    } as RunModeChangedEvent);
  }

  emitRunPhaseChanged(
    runId: string,
    phase: RunPhase,
    previousPhase: RunPhase,
    reason?: string
  ): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "run.phase.changed",
      phase,
      previousPhase,
      reason,
    } as RunPhaseChangedEvent);
  }

  emitNodeControlChanged(
    runId: string,
    nodeId: string,
    control: NodeControl,
    previousControl: NodeControl
  ): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "node.control.changed",
      nodeId,
      control,
      previousControl,
    } as NodeControlChangedEvent);
  }

  // Turn event helpers (for manual control)

  emitTurnStarted(
    runId: string,
    nodeId: string,
    turnId: string,
    turnNumber: number,
    isManual: boolean,
    prompt?: string
  ): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "turn.started",
      nodeId,
      turnId,
      turnNumber,
      isManual,
      prompt,
    } as TurnStartedEvent);
  }

  emitTurnCompleted(
    runId: string,
    nodeId: string,
    turnId: string,
    turnNumber: number,
    isManual: boolean,
    result?: { content?: string; tokenCount?: number; durationMs?: number },
    error?: { message: string; stack?: string }
  ): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "turn.completed",
      nodeId,
      turnId,
      turnNumber,
      isManual,
      result,
      error,
    } as TurnCompletedEvent);
  }

  // Prompt queue event helpers

  emitPromptQueued(runId: string, prompt: PendingPrompt): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "prompt.queued",
      prompt,
    } as PromptQueuedEvent);
  }

  emitPromptSent(runId: string, promptId: string, nodeId?: string): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "prompt.sent",
      promptId,
      nodeId,
    } as PromptSentEvent);
  }

  emitPromptCancelled(runId: string, promptId: string, reason?: string): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "prompt.cancelled",
      promptId,
      reason,
    } as PromptCancelledEvent);
  }

  private applyToRun(run: RunRecord, event: VuhlpEvent): void {
    run.updatedAt = event.ts;

    switch (event.type) {
      case "run.created":
      case "run.started":
      case "run.updated":
      case "run.completed":
      case "run.failed":
      case "run.stopped": {
        const e = event as RunEvent;
        Object.assign(run, e.run);
        return;
      }

      case "node.created":
      case "node.started":
      case "node.progress":
      case "node.completed":
      case "node.failed": {
        const e = event as NodeEvent;
        const existing = run.nodes[e.nodeId];
        if (!existing) {
          // node.created should include full node data via patch
          run.nodes[e.nodeId] = {
            id: e.nodeId,
            runId: run.id,
            type: "task",
            label: e.nodeId,
            status: "queued",
            createdAt: event.ts,
            ...(e.patch ?? {}),
          } as any;
        } else if (e.patch) {
          Object.assign(existing, e.patch);
        }
        return;
      }

      case "node.deleted": {
        const e = event as NodeDeletedEvent;
        delete run.nodes[e.nodeId];

        for (const [edgeId, edge] of Object.entries(run.edges)) {
          if (edge.from === e.nodeId || edge.to === e.nodeId) {
            delete run.edges[edgeId];
          }
        }

        for (const [artifactId, artifact] of Object.entries(run.artifacts)) {
          if (artifact.nodeId === e.nodeId) {
            delete run.artifacts[artifactId];
          }
        }
        return;
      }

      case "edge.created": {
        const e = event as EdgeEvent;
        run.edges[e.edge.id] = e.edge;
        return;
      }

      case "edge.deleted": {
        const e = event as EdgeDeletedEvent;
        delete run.edges[e.edgeId];
        return;
      }

      case "artifact.created": {
        const e = event as ArtifactEvent;
        run.artifacts[e.artifact.id] = e.artifact;
        return;
      }

      case "verification.completed": {
        // stored as node.output maybe
        const e = event as VerificationCompletedEvent;
        const node = run.nodes[e.nodeId];
        if (node) {
          node.output = e.report;
        }
        return;
      }

      // Run mode changed - update mode in run record
      case "run.mode.changed": {
        const e = event as RunModeChangedEvent;
        run.mode = e.mode;
        return;
      }

      // Run phase changed - update phase in run record
      case "run.phase.changed": {
        const e = event as RunPhaseChangedEvent;
        run.phase = e.phase;
        return;
      }

      // Node control changed - update control in node record
      case "node.control.changed": {
        const e = event as NodeControlChangedEvent;
        const node = run.nodes[e.nodeId];
        if (node) {
          node.control = e.control;
        }
        return;
      }

      // Turn events - update turn count in node record
      case "turn.completed": {
        const e = event as TurnCompletedEvent;
        const node = run.nodes[e.nodeId];
        if (node) {
          node.lastTurnId = e.turnId;
          node.turnCount = e.turnNumber;
        }
        return;
      }

      // Broadcast-only events (no state mutation, streamed to UI)
      case "run.paused":
      case "run.resumed":
      case "message.user":
      case "message.assistant.delta":
      // message.assistant.final handled below for persistence
      case "message.reasoning":
      case "tool.proposed":
      case "tool.started":
      case "tool.completed":
      case "console.chunk":
      case "approval.requested":
      case "approval.resolved":
      case "handoff.sent":
      case "handoff.reported":
      case "chat.message.sent":
      case "chat.message.queued":
      case "interaction.mode.changed":
      case "turn.started":
      case "prompt.queued":
      case "prompt.sent":
      case "prompt.cancelled":
        // These events are broadcast to subscribers but don't mutate RunRecord
        return;

      case "message.assistant.final": {
        const e = event as MessageAssistantFinalEvent;
        const msg: ChatMessageRecord = {
          id: randomUUID(),
          runId: run.id,
          nodeId: e.nodeId,
          role: "assistant",
          content: e.content,
          createdAt: e.ts,
          processed: true, // Output is already processed
          interruptedExecution: false,
        };
        if (!run.chatMessages) run.chatMessages = [];
        run.chatMessages.push(msg);
        return;
      }

      default:
        return;
    }
  }
}
