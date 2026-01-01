export interface CreateRunRequest {
  workspace_path: string;
  spec_path: string;
}

export interface CreateRunResponse {
  run_id: string;
}

export interface ApproveRequest {
  step_id: string;
}

export interface CreateSessionRequest {
  workspace_path: string;
  system_prompt?: string;
  auto_run?: boolean;
  mode?: string;
  spec_path?: string;
}

export interface CreateSessionResponse {
  session_id: string;
  spec_path?: string;
}

export interface UpdateSessionModeRequest {
  mode: string;
  spec_path?: string;
}

export interface UpdateSessionModeResponse {
  session_id: string;
  mode: string;
  spec_path?: string;
}

export interface MessagePart {
  type: string;
  text?: string;
  ref?: string;
  mime_type?: string;
}

export interface AddMessageRequest {
  role: string;
  parts: MessagePart[];
  auto_run?: boolean;
}

export interface AddMessageResponse {
  message_id: string;
  turn_id: string;
}

export interface SessionApproveRequest {
  turn_id?: string;
  tool_call_id: string;
  action?: string;
  reason?: string;
}

export interface AttachmentUploadRequest {
  name?: string;
  mime_type?: string;
  content_base64: string;
}

export interface AttachmentUploadResponse {
  ref: string;
  mime_type: string;
}

export interface GenerateSpecRequest {
  workspace_path: string;
  spec_name: string;
  prompt: string;
  overwrite?: boolean;
}

export interface GenerateSpecResponse {
  spec_path: string;
  content: string;
}
