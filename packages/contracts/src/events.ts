import type {
  ApprovalResolution,
  Artifact,
  EdgeState,
  Envelope,
  ISO8601,
  NodeState,
  NodeStatus,
  ProviderName,
  OrchestrationMode,
  GlobalMode,
  RunState,
  UsageTotals,
  UUID,
  ToolCall,
  UserMessageRecord
} from "./types.js";

export type EventType =
  | "run.patch"
  | "run.mode"
  | "run.stalled"
  | "node.patch"
  | "node.heartbeat"
  | "node.log"
  | "node.deleted"
  | "node.progress"
  | "turn.status"
  | "edge.created"
  | "edge.deleted"
  | "handoff.sent"
  | "message.user"
  | "message.assistant.delta"
  | "message.assistant.final"
  | "message.assistant.thinking.delta"
  | "message.assistant.thinking.final"
  | "tool.proposed"
  | "tool.started"
  | "tool.completed"
  | "approval.requested"
  | "approval.resolved"
  | "artifact.created"
  | "telemetry.usage";

export type TurnStatus =
  | "turn.started"
  | "waiting_for_model"
  | "tool.pending"
  | "awaiting_approval"
  | "turn.completed"
  | "turn.interrupted"
  | "turn.failed";

export interface BaseEvent {
  id: UUID;
  runId: UUID;
  ts: ISO8601;
  type: EventType;
  nodeId?: UUID;
}

export interface RunPatchEvent extends BaseEvent {
  type: "run.patch";
  patch: Partial<RunState>;
}

export interface RunModeEvent extends BaseEvent {
  type: "run.mode";
  mode?: OrchestrationMode;
  globalMode?: GlobalMode;
}

export interface RunStalledEvent extends BaseEvent {
  type: "run.stalled";
  evidence: {
    outputHash?: string;
    diffHash?: string;
    verificationFailure?: string;
    summaries: string[];
  };
}

export interface NodePatchEvent extends BaseEvent {
  type: "node.patch";
  nodeId: UUID;
  patch: Partial<NodeState>;
}

export interface NodeHeartbeatEvent extends BaseEvent {
  type: "node.heartbeat";
  nodeId: UUID;
}

export interface NodeLogEvent extends BaseEvent {
  type: "node.log";
  nodeId: UUID;
  source: "stdout" | "stderr";
  line: string;
}

export interface NodeDeletedEvent extends BaseEvent {
  type: "node.deleted";
  nodeId: UUID;
}

export interface NodeProgressEvent extends BaseEvent {
  type: "node.progress";
  nodeId: UUID;
  status: NodeStatus;
  summary?: string;
}

export interface TurnStatusEvent extends BaseEvent {
  type: "turn.status";
  nodeId: UUID;
  status: TurnStatus;
  detail?: string;
}

export interface EdgeCreatedEvent extends BaseEvent {
  type: "edge.created";
  edge: EdgeState;
}

export interface EdgeDeletedEvent extends BaseEvent {
  type: "edge.deleted";
  edgeId: UUID;
}

export interface HandoffSentEvent extends BaseEvent {
  type: "handoff.sent";
  envelope: Envelope;
}

export interface MessageUserEvent extends BaseEvent {
  type: "message.user";
  message: UserMessageRecord;
}

export interface MessageAssistantDeltaEvent extends BaseEvent {
  type: "message.assistant.delta";
  nodeId: UUID;
  delta: string;
}

export interface MessageAssistantFinalEvent extends BaseEvent {
  type: "message.assistant.final";
  nodeId: UUID;
  content: string;
  status?: "final" | "interrupted";
}

export interface MessageAssistantThinkingDeltaEvent extends BaseEvent {
  type: "message.assistant.thinking.delta";
  nodeId: UUID;
  delta: string;
}

export interface MessageAssistantThinkingFinalEvent extends BaseEvent {
  type: "message.assistant.thinking.final";
  nodeId: UUID;
  content: string;
}

export interface ToolProposedEvent extends BaseEvent {
  type: "tool.proposed";
  nodeId: UUID;
  tool: ToolCall;
}

export interface ToolStartedEvent extends BaseEvent {
  type: "tool.started";
  nodeId: UUID;
  tool: ToolCall;
}

export interface ToolCompletedEvent extends BaseEvent {
  type: "tool.completed";
  nodeId: UUID;
  toolId: UUID;
  result: { ok: boolean; output?: string | object };
  error?: { message: string };
}

export interface ApprovalRequestedEvent extends BaseEvent {
  type: "approval.requested";
  approvalId: UUID;
  nodeId: UUID;
  tool: ToolCall;
  context?: string;
}

export interface ApprovalResolvedEvent extends BaseEvent {
  type: "approval.resolved";
  approvalId: UUID;
  resolution: ApprovalResolution;
}

export interface ArtifactCreatedEvent extends BaseEvent {
  type: "artifact.created";
  artifact: Artifact;
}

export interface TelemetryUsageEvent extends BaseEvent {
  type: "telemetry.usage";
  provider: ProviderName;
  model: string;
  usage: UsageTotals;
}

export type EventEnvelope =
  | RunPatchEvent
  | RunModeEvent
  | RunStalledEvent
  | NodePatchEvent
  | NodeHeartbeatEvent
  | NodeLogEvent
  | NodeDeletedEvent
  | NodeProgressEvent
  | TurnStatusEvent
  | EdgeCreatedEvent
  | EdgeDeletedEvent
  | HandoffSentEvent
  | MessageUserEvent
  | MessageAssistantDeltaEvent
  | MessageAssistantFinalEvent
  | MessageAssistantThinkingDeltaEvent
  | MessageAssistantThinkingFinalEvent
  | ToolProposedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ArtifactCreatedEvent
  | TelemetryUsageEvent;
