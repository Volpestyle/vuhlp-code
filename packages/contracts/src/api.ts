import type {
  ApprovalRequest,
  ApprovalResolution,
  Artifact,
  EdgeState,
  Envelope,
  GlobalMode,
  NodeConfig,
  NodeConfigInput,
  NodeState,
  OrchestrationMode,
  RunState,
  UUID
} from "./types.js";
import type { EventEnvelope } from "./events.js";

export interface ListDirectoryRequest {
  path?: string;
}

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  path: string;
}

export interface ListDirectoryResponse {
  entries: FileEntry[];
  parent?: string;
  current: string;
}

export interface CreateRunRequest {
  mode?: OrchestrationMode;
  globalMode?: GlobalMode;
  cwd?: string;
}

export interface CreateRunResponse {
  run: RunState;
}

export interface ListRunsResponse {
  runs: RunState[];
}

export interface GetRunResponse {
  run: RunState;
}

export interface GetRunEventsResponse {
  events: EventEnvelope[];
}

export interface UpdateRunRequest {
  patch: Partial<Pick<RunState, "status" | "mode" | "globalMode">>;
}

export interface UpdateRunResponse {
  run: RunState;
}

export interface DeleteRunResponse {
  runId: UUID;
}

export interface CreateNodeRequest {
  node: NodeConfigInput;
}

export interface CreateNodeResponse {
  node: NodeState;
}

export interface UpdateNodeRequest {
  patch: Partial<NodeState>;
  config?: Partial<NodeConfig>;
}

export interface UpdateNodeResponse {
  node: NodeState;
}

export interface CreateEdgeRequest {
  edge: Omit<EdgeState, "id"> & { id?: UUID };
}

export interface CreateEdgeResponse {
  edge: EdgeState;
}

export interface DeleteEdgeResponse {
  edgeId: UUID;
}

export interface DeleteNodeResponse {
  nodeId: UUID;
}

export interface PostChatRequest {
  nodeId: UUID;
  content: string;
  interrupt?: boolean;
}

export interface PostChatResponse {
  messageId: UUID;
}

export interface ListApprovalsResponse {
  approvals: Array<{ runId: UUID; approval: ApprovalRequest }>;
}

export interface ResolveApprovalRequest {
  resolution: ApprovalResolution;
  runId?: UUID;
}

export interface ResolveApprovalResponse {
  approvalId: UUID;
  resolution: ApprovalResolution;
}

export interface HandoffDelivery {
  envelope: Envelope;
}

export interface ResetNodeResponse {
  ok: true;
}

export interface GetArtifactResponse {
  artifact: Artifact;
  content: string;
}

export interface GetRoleTemplateResponse {
  name: string;
  content: string;
  found: boolean;
}
