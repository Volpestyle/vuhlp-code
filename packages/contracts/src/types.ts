export type UUID = string;
export type ISO8601 = string;

export type ContractVersion = "1";

export type RunStatus = "queued" | "running" | "paused" | "stopped" | "completed" | "failed";
export type OrchestrationMode = "AUTO" | "INTERACTIVE";
export type GlobalMode = "PLANNING" | "IMPLEMENTATION";

export type ProviderName = "codex" | "claude" | "gemini" | "custom";

export type NodeStatus = "idle" | "running" | "blocked" | "failed";

export type EdgeType = "handoff" | "report";

export type ArtifactKind = "diff" | "prompt" | "log" | "transcript" | "contextpack" | "report";

export type EdgeManagementScope = "none" | "self" | "all";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GraphPosition {
  x: number;
  y: number;
}

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface GraphLayout {
  positions: Record<UUID, GraphPosition>;
  viewport: GraphViewport;
  updatedAt: ISO8601;
}

export interface RunState {
  id: UUID;
  contractVersion: ContractVersion;
  status: RunStatus;
  mode: OrchestrationMode;
  globalMode: GlobalMode;
  createdAt: ISO8601;
  updatedAt: ISO8601;
  usage?: UsageTotals;
  nodes: Record<UUID, NodeState>;
  nodeConfigs: Record<UUID, NodeConfig>;
  edges: Record<UUID, EdgeState>;
  artifacts: Record<UUID, Artifact>;
  cwd?: string;
  layout?: GraphLayout;
}

export interface NodeCapabilities {
  edgeManagement: EdgeManagementScope;
  writeCode: boolean;
  writeDocs: boolean;
  runCommands: boolean;
  delegateOnly: boolean;
}

export type CliPermissionsMode = "skip" | "gated";

export interface NodePermissions {
  cliPermissionsMode: CliPermissionsMode;
  agentManagementRequiresApproval: boolean;
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
  alias?: string;
  roleTemplate: string;
  customSystemPrompt?: string | null;
  provider: ProviderName;
  status: NodeStatus;
  summary: string;
  lastActivityAt: ISO8601;
  usage?: UsageTotals;
  capabilities: NodeCapabilities;
  permissions: NodePermissions;
  session: NodeSession;
  connection?: NodeConnection;
  inboxCount?: number;
  todos?: TodoItem[];
}

export interface NodeConfig {
  id?: UUID;
  label: string;
  alias?: string;
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
  alias?: string;
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

export type HandoffResponseExpectation = "none" | "optional" | "required";

export interface HandoffResponse {
  expectation: HandoffResponseExpectation;
  replyTo?: UUID;
}

export interface HandoffPayload {
  message: string;
  structured?: Record<string, unknown>;
  artifacts?: ArtifactRef[];
  status?: HandoffStatus;
  response?: HandoffResponse;
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

export interface ApprovalResolution {
  status: "approved" | "denied" | "modified";
  modifiedArgs?: Record<string, unknown>;
  reason?: string;
}

export interface ApprovalRequest {
  approvalId: UUID;
  nodeId: UUID;
  tool: ToolCall;
  context?: string;
}


export interface ChatMessage {
  id: string;
  nodeId: UUID;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: ISO8601;
  streaming?: boolean;
  status?: "final" | "interrupted";
  thinking?: string;
  thinkingStreaming?: boolean;
  pending?: boolean;
  sendError?: string;
  rawContent?: string;
  interrupt?: boolean;
}

export interface ToolEvent {
  id: UUID;
  nodeId: UUID;
  tool: ToolCall;
  status: "proposed" | "started" | "completed" | "failed";
  timestamp: ISO8601;
  result?: { ok: boolean; output?: string | object };
  error?: { message: string };
}
