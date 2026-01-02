export type SessionStatus =
  | "active"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "canceled";

export type SessionMode = "chat" | "spec";

export type TurnStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed";

export interface MessagePart {
  type: string;
  text?: string;
  ref?: string;
  mime_type?: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_input?: unknown;
}

export interface Message {
  id: string;
  role: string;
  parts: MessagePart[];
  created_at: string;
  tool_call_id?: string;
}

export interface Turn {
  id: string;
  status: TurnStatus;
  started_at?: string;
  completed_at?: string;
  error?: string;
}

export interface Session {
  id: string;
  created_at: string;
  updated_at: string;
  status: SessionStatus;
  mode?: SessionMode;
  workspace_path: string;
  system_prompt?: string;
  spec_path?: string;
  last_turn_id?: string;
  messages?: Message[];
  turns?: Turn[];
  error?: string;
}

export interface SessionEvent {
  ts: string;
  session_id: string;
  turn_id?: string;
  type: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface ApprovalDecision {
  action: string;
  reason?: string;
}
