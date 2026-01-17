export type UUID = string;
export type ISO8601 = string;

export type ContractVersion = "1";

export type RunStatus = "queued" | "running" | "paused" | "completed" | "failed";
export type OrchestrationMode = "AUTO" | "INTERACTIVE";
export type GlobalMode = "PLANNING" | "IMPLEMENTATION";

export type ProviderName = "codex" | "claude" | "gemini" | "custom";

export type NodeStatus = "idle" | "running" | "blocked" | "failed";

export type EdgeType = "handoff" | "report";

export type ArtifactKind = "diff" | "prompt" | "log" | "transcript" | "contextpack" | "report";

export interface RunState {
  id: UUID;
  contractVersion: ContractVersion;
  status: RunStatus;
  mode: OrchestrationMode;
  globalMode: GlobalMode;
  createdAt: ISO8601;
  updatedAt: ISO8601;
  nodes: Record<UUID, NodeState>;
  edges: Record<UUID, EdgeState>;
  artifacts: Record<UUID, Artifact>;
}

export interface NodeCapabilities {
  spawnNodes: boolean;
  writeCode: boolean;
  writeDocs: boolean;
  runCommands: boolean;
  delegateOnly: boolean;
}

export type CliPermissionsMode = "skip" | "gated";

export interface NodePermissions {
  cliPermissionsMode: CliPermissionsMode;
  spawnRequiresApproval: boolean;
}

export interface NodeSession {
  sessionId: string;
  resetCommands: string[];
}

export interface NodeSessionConfig {
  resume: boolean;
  resetCommands: string[];
}

export type ConnectionStatus = "connected" | "idle" | "disconnected";

export interface NodeConnection {
  status: ConnectionStatus;
  streaming: boolean;
  lastHeartbeatAt: ISO8601;
  lastOutputAt: ISO8601;
}

export interface NodeState {
  id: UUID;
  runId: UUID;
  label: string;
  roleTemplate: string;
  customSystemPrompt?: string | null;
  provider: ProviderName;
  status: NodeStatus;
  summary: string;
  lastActivityAt: ISO8601;
  capabilities: NodeCapabilities;
  permissions: NodePermissions;
  session: NodeSession;
  connection?: NodeConnection;
  inboxCount?: number;
}

export interface NodeConfig {
  id?: UUID;
  label: string;
  provider: ProviderName;
  roleTemplate: string;
  customSystemPrompt?: string | null;
  capabilities: NodeCapabilities;
  permissions: NodePermissions;
  session: NodeSessionConfig;
}

export interface NodeConfigInput {
  id?: UUID;
  label: string;
  provider: ProviderName;
  roleTemplate: string;
  customSystemPrompt?: string | null;
  capabilities?: Partial<NodeCapabilities>;
  permissions?: Partial<NodePermissions>;
  session?: Partial<NodeSessionConfig>;
}

export interface EdgeState {
  id: UUID;
  from: UUID;
  to: UUID;
  bidirectional: boolean;
  type: EdgeType;
  label: string;
}

export interface ArtifactMetadata {
  filesChanged?: string[];
  summary?: string;
}

export interface Artifact {
  id: UUID;
  runId: UUID;
  nodeId: UUID;
  kind: ArtifactKind;
  name: string;
  path: string;
  createdAt: ISO8601;
  metadata?: ArtifactMetadata;
}

export interface ArtifactRef {
  type: string;
  ref: string;
}

export interface HandoffStatus {
  ok: boolean;
  reason?: string;
}

export interface HandoffPayload {
  message: string;
  structured?: Record<string, unknown>;
  artifacts?: ArtifactRef[];
  status?: HandoffStatus;
}

export type EnvelopeKind = "handoff" | "signal";

export interface Envelope {
  kind: EnvelopeKind;
  id: UUID;
  fromNodeId: UUID;
  toNodeId: UUID;
  createdAt: ISO8601;
  payload: HandoffPayload;
  contextRef?: string;
  meta?: Record<string, unknown>;
}

export interface UserMessageRecord {
  id: UUID;
  runId: UUID;
  nodeId?: UUID;
  role: "user" | "assistant" | "system";
  content: string;
  interrupt?: boolean;
  createdAt: ISO8601;
}

export interface ContextPack {
  packId: UUID;
  runId: UUID;
  nodeId: UUID;
  createdAt: ISO8601;
  goal: string;
  definitionOfDone: string[];
  globalMode: GlobalMode;
  nodeMode: OrchestrationMode;
  docsRoot: string;
  docRefs: Array<{ path: string; excerpt: string }>;
  repoFacts: Record<string, unknown>;
  relevantFiles: Array<{ path: string; summary: string }>;
  inputs: Array<{ payloadId: UUID }>;
  artifacts: Array<{ id: UUID; kind: ArtifactKind }>;
  constraints: Record<string, unknown>;
}

export interface PromptBlocks {
  system: string;
  role: string;
  mode: string;
  task: string;
  override?: string;
}

export interface PromptArtifacts {
  full: string;
  blocks: PromptBlocks;
  hash: string;
}

export interface ToolCall {
  id: UUID;
  name: string;
  args: Record<string, unknown>;
}

export interface ApprovalRequest {
  approvalId: UUID;
  nodeId: UUID;
  tool: ToolCall;
  context?: string;
}

export interface ApprovalResolution {

  status: "approved" | "denied" | "modified";

  modifiedArgs?: Record<string, unknown>;

}
