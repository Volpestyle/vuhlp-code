// Core types for vuhlp orchestration system

// ============================================================================
// Node & Edge Types
// ============================================================================

export type NodeType = 'orchestrator' | 'task' | 'verification' | 'merge';
export type NodeStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
export type EdgeType = 'handoff' | 'dependency' | 'report' | 'gate';
export type Provider = 'claude' | 'codex' | 'gemini' | 'mock';

export interface Node {
  id: string;
  label: string;
  type?: NodeType;
  status: NodeStatus;
  providerId?: Provider;
  parentId?: string;
  instructions?: string;
  context?: string;
  output?: unknown;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface Edge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label?: string;
}

// ============================================================================
// Run Types
// ============================================================================

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'paused';
export type RunMode = 'AUTO' | 'INTERACTIVE';
export type GlobalMode = 'PLANNING' | 'IMPLEMENTATION';
export type RunPhase =
  | 'BOOT'
  | 'DOCS_ITERATION'
  | 'INVESTIGATE'
  | 'PLAN'
  | 'EXECUTE'
  | 'VERIFY'
  | 'DOCS_SYNC'
  | 'DONE';

export type InteractionMode = 'autonomous' | 'interactive';

export interface RepoFacts {
  language: string;
  hasTests: boolean;
  hasDocs: boolean;
  isEmptyRepo: boolean;
  isGitRepo: boolean;
  hasCode?: boolean;
}

export interface RunPolicy {
  skipCliPermissions?: boolean;
}

export interface Run {
  id: string;
  name?: string;
  prompt: string;
  repoPath: string;
  status: RunStatus;
  mode?: RunMode;
  globalMode?: GlobalMode;
  phase?: RunPhase;
  rootOrchestratorNodeId?: string;
  nodes?: Record<string, Node>;
  edges?: Record<string, Edge>;
  artifacts?: Record<string, Artifact>;
  repoFacts?: RepoFacts;
  iteration?: number;
  maxIterations?: number;
  policy?: RunPolicy;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  archived?: boolean;
  archivedAt?: string;
  chatMessages?: ChatMessage[];
}

// ============================================================================
// Artifact Types
// ============================================================================

export type ArtifactType = 'log' | 'diff' | 'json' | 'verification' | 'file_changes';

export interface Artifact {
  id: string;
  runId: string;
  nodeId: string;
  type: ArtifactType;
  name: string;
  path?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ============================================================================
// Event Types (for Inspector tabs)
// ============================================================================

export type ToolRiskLevel = 'low' | 'medium' | 'high';
export type ToolStatus = 'proposed' | 'started' | 'completed' | 'failed';

export interface MessageEvent {
  id: string;
  type: 'user' | 'assistant' | 'reasoning' | 'system';
  content: string;
  timestamp: string;
  nodeId?: string;
  isPartial?: boolean;
}

export interface ToolEvent {
  id: string;
  toolId: string;
  name: string;
  args: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  status: ToolStatus;
  result?: unknown;
  error?: { message: string };
  durationMs?: number;
  timestamp: string;
  nodeId?: string;
}

export interface ConsoleChunk {
  id: string;
  nodeId: string;
  stream: 'stdout' | 'stderr';
  data: string;
  timestamp: string;
}

export interface GenericEvent {
  id: string;
  type: string;
  runId: string;
  nodeId?: string;
  timestamp: string;
  message: string;
  raw: unknown;
}

export interface NodeTrackedState {
  messages: MessageEvent[];
  tools: ToolEvent[];
  consoleChunks: ConsoleChunk[];
  events: GenericEvent[];
}

// ============================================================================
// Approval Types
// ============================================================================

export interface ApprovalRequest {
  id: string;
  runId: string;
  nodeId: string;
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  description?: string;
  createdAt: string;
}

// ============================================================================
// Prompt Queue Types (INTERACTIVE mode)
// ============================================================================

export type PromptStatus = 'pending' | 'sent' | 'cancelled';
export type PromptOrigin = 'orchestrator' | 'user';

export interface PendingPrompt {
  id: string;
  runId: string;
  targetNodeId?: string;
  content: string;
  origin: PromptOrigin;
  status: PromptStatus;
  createdAt: string;
  sentAt?: string;
}

// ============================================================================
// Config Types
// ============================================================================

export interface VuhlpConfig {
  dataDir?: string;
  server?: {
    port?: number;
  };
  workspace?: {
    mode?: 'shared' | 'worktree' | 'copy';
    rootDir?: string;
  };
  scheduler?: {
    maxConcurrency?: number;
  };
  orchestration?: {
    maxIterations?: number;
  };
  verification?: {
    commands?: string[];
  };
  roles?: Record<string, string>;
  providers?: Record<string, unknown>;
}

// ============================================================================
// Provider Info
// ============================================================================

export interface ProviderInfo {
  id: string;
  displayName: string;
  kind: string;
  capabilities?: string[];
  health?: 'healthy' | 'unhealthy' | 'unknown';
}

// ============================================================================
// Daemon State (for client hook)
// ============================================================================

export interface DaemonState {
  runs: Record<string, Run>;
  nodeLogs: Record<string, Record<string, string[]>>;
  nodeTrackedState: Record<string, Record<string, NodeTrackedState>>;
  providers: ProviderInfo[];
  connStatus: string;
  pendingApprovals: ApprovalRequest[];
  pendingPrompts: PendingPrompt[];
}

// ============================================================================
// File System Response (for repo browser)
// ============================================================================

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FsResponse {
  path: string;
  parent?: string;
  entries: FsEntry[];
  error?: string;
}

// ============================================================================
// Chat Types
// ============================================================================

export interface ChatMessage {
  id: string;
  runId: string;
  nodeId?: string;
  role: 'user' | 'system' | 'assistant';
  content: string;
  timestamp: string;
  processed: boolean;
  interruptedExecution: boolean;
}

export interface ChatTarget {
  type: 'node' | 'orchestrator';
  nodeId?: string;
  label: string;
}
