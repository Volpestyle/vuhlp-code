/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * Canonical vuhlp event + state types.
 *
 * v0 is intentionally conservative and stores provider-specific raw payloads
 * as artifacts to avoid throwing away information.
 */

export type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export type NodeType = "orchestrator" | "task" | "verification" | "merge";
export type NodeStatus = "queued" | "running" | "completed" | "failed" | "skipped";

export type EdgeType = "handoff" | "dependency" | "report" | "gate";

export type ProviderId = string; // e.g. "mock", "codex", "claude", "gemini"
export type RoleId = "investigator" | "planner" | "implementer" | "reviewer";

export interface RunConfigSnapshot {
  // An intentionally flexible config snapshot persisted with each run.
  [k: string]: unknown;
}

export interface RunRecord {
  id: string;
  prompt: string;
  repoPath: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  iterations: number;
  maxIterations: number;
  config: RunConfigSnapshot;

  rootOrchestratorNodeId: string;

  nodes: Record<string, NodeRecord>;
  edges: Record<string, EdgeRecord>;
  artifacts: Record<string, ArtifactRecord>;
}

export interface NodeRecord {
  id: string;
  runId: string;
  parentNodeId?: string; // for nested orchestrators
  type: NodeType;

  label: string;
  role?: RoleId;
  providerId?: ProviderId;

  status: NodeStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  // Inputs and outputs are intentionally untyped in v0.
  input?: unknown;
  output?: unknown;

  // Human-readable summary.
  summary?: string;

  workspacePath?: string;
  error?: {
    message: string;
    stack?: string;
  };
}

export interface EdgeRecord {
  id: string;
  runId: string;
  from: string;
  to: string;
  type: EdgeType;
  label?: string;
  createdAt: string;
}

export type ArtifactKind = "log" | "diff" | "json" | "text" | "report" | "binary";

export interface ArtifactRecord {
  id: string;
  runId: string;
  nodeId: string;
  kind: ArtifactKind;
  name: string;
  mimeType: string;
  path: string; // absolute path on disk
  createdAt: string;
  meta?: Record<string, unknown>;
}

export type VuhlpEventType =
  | "run.created"
  | "run.started"
  | "run.updated"
  | "run.completed"
  | "run.failed"
  | "run.stopped"
  | "node.created"
  | "node.started"
  | "node.progress"
  | "node.completed"
  | "node.failed"
  | "edge.created"
  | "artifact.created"
  | "verification.completed";

export interface VuhlpEventBase {
  id: string;
  runId: string;
  ts: string;
  type: VuhlpEventType;
}

export interface RunEvent extends VuhlpEventBase {
  type:
    | "run.created"
    | "run.started"
    | "run.updated"
    | "run.completed"
    | "run.failed"
    | "run.stopped";
  run: Partial<RunRecord> & { id: string };
}

export interface NodeEvent extends VuhlpEventBase {
  type:
    | "node.created"
    | "node.started"
    | "node.progress"
    | "node.completed"
    | "node.failed";
  nodeId: string;
  patch?: Partial<NodeRecord>;
  message?: string;
  raw?: unknown;
}

export interface EdgeEvent extends VuhlpEventBase {
  type: "edge.created";
  edge: EdgeRecord;
}

export interface ArtifactEvent extends VuhlpEventBase {
  type: "artifact.created";
  artifact: ArtifactRecord;
}

export interface VerificationCompletedEvent extends VuhlpEventBase {
  type: "verification.completed";
  nodeId: string;
  report: {
    ok: boolean;
    commands: Array<{
      command: string;
      ok: boolean;
      code: number | null;
      durationMs: number;
      logArtifactId?: string;
    }>;
  };
}

export type VuhlpEvent =
  | RunEvent
  | NodeEvent
  | EdgeEvent
  | ArtifactEvent
  | VerificationCompletedEvent;
