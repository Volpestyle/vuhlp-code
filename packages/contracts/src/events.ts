import type {
  ApprovalResolution,
  Artifact,
  EdgeState,
  Envelope,
  ISO8601,
  NodeState,
  NodeStatus,
  OrchestrationMode,
  GlobalMode,
  RunState,
  UUID,
  ToolCall,
  UserMessageRecord
} from "./types.js";

export type EventType =
  | "run.patch"
  | "run.mode"
  | "run.stalled"
  | "node.patch"
  | "node.deleted"
  | "node.progress"
  | "edge.created"
  | "edge.deleted"
  | "handoff.sent"
  | "message.user"
  | "message.assistant.delta"
  | "message.assistant.final"
  | "tool.proposed"
  | "tool.started"
  | "tool.completed"
  | "approval.requested"
  | "approval.resolved"
  | "artifact.created";

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
  result: { ok: boolean };
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

export type EventEnvelope =
  | RunPatchEvent
  | RunModeEvent
  | RunStalledEvent
  | NodePatchEvent
  | NodeDeletedEvent
  | NodeProgressEvent
  | EdgeCreatedEvent
  | EdgeDeletedEvent
  | HandoffSentEvent
  | MessageUserEvent
  | MessageAssistantDeltaEvent
  | MessageAssistantFinalEvent
  | ToolProposedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ArtifactCreatedEvent;
