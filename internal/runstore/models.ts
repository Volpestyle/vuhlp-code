export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "canceled";

export type StepStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "skipped";

export interface Step {
  id: string;
  title: string;
  type: string;
  needs_approval: boolean;
  command?: string;
  status: StepStatus;
  started_at?: string;
  completed_at?: string;
}

export interface Run {
  id: string;
  created_at: string;
  updated_at: string;
  status: RunStatus;
  workspace_path: string;
  spec_path: string;
  model_canonical?: string;
  steps?: Step[];
  error?: string;
}

export interface Event {
  ts: string;
  run_id: string;
  type: string;
  message?: string;
  data?: Record<string, unknown>;
}
