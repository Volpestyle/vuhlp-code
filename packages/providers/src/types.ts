import type {
  ApprovalResolution,
  CliPermissionsMode,
  EdgeType,
  EventEnvelope,
  GlobalMode,
  NodeCapabilities,
  NodePermissions,
  NodeSessionConfig,
  ProviderName,
  UUID
} from "@vuhlp/contracts";

export type PromptKind = "full" | "delta";

export interface ProviderTurnInput {
  prompt: string;
  promptKind: PromptKind;
  turnId?: UUID;
}

export type ProviderProtocol = "jsonl" | "raw" | "stream-json";
export type ProviderTransport = "cli" | "api";

export interface SpawnNodeRequest {
  label: string;
  roleTemplate: string;
  provider: ProviderName;
  customSystemPrompt?: string | null;
  capabilities?: Partial<NodeCapabilities>;
  permissions?: Partial<NodePermissions>;
  session?: Partial<NodeSessionConfig>;
  instructions?: string;
  input?: Record<string, unknown>;
}

export interface SpawnNodeResult {
  nodeId: UUID;
  label: string;
  roleTemplate: string;
  provider: ProviderName;
}

export type SpawnNodeHandler = (request: SpawnNodeRequest) => Promise<SpawnNodeResult>;

export interface CreateEdgeRequest {
  from: UUID;
  to: UUID;
  bidirectional?: boolean;
  type?: EdgeType;
  label?: string;
}

export interface CreateEdgeResult {
  edgeId: UUID;
  from: UUID;
  to: UUID;
  bidirectional: boolean;
  type: EdgeType;
  label: string;
}

export type CreateEdgeHandler = (request: CreateEdgeRequest) => Promise<CreateEdgeResult>;

interface ProviderConfigBase {
  runId: UUID;
  nodeId: UUID;
  provider: ProviderName;
  cwd?: string;
  env?: Record<string, string>;
  permissionsMode: CliPermissionsMode;
  spawnRequiresApproval?: boolean;
  spawnNode?: SpawnNodeHandler;
  createEdge?: CreateEdgeHandler;
  resume: boolean;
  resetCommands: string[];
  capabilities?: NodeCapabilities;
  globalMode?: GlobalMode;
}

export interface CliProviderConfig extends ProviderConfigBase {
  transport?: "cli";
  command: string;
  args?: string[];
  protocol: ProviderProtocol;
}

export interface ApiProviderConfig extends ProviderConfigBase {
  transport: "api";
  apiKey: string;
  apiBaseUrl?: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export type ProviderConfig = CliProviderConfig | ApiProviderConfig;

export type ProviderEventListener = (event: EventEnvelope) => void;
export type ProviderErrorListener = (error: Error) => void;

export interface ProviderAdapter {
  start(): Promise<void>;
  send(input: ProviderTurnInput): Promise<void>;
  interrupt(): Promise<void>;
  resolveApproval(approvalId: UUID, resolution: ApprovalResolution): Promise<void>;
  resetSession(): Promise<void>;
  close(): Promise<void>;
  getSessionId(): string | null;
  onEvent(listener: ProviderEventListener): () => void;
  onError(listener: ProviderErrorListener): () => void;
}
