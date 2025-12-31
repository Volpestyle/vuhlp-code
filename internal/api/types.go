package api

type CreateRunRequest struct {
	WorkspacePath string `json:"workspace_path"`
	SpecPath      string `json:"spec_path"`
}

type CreateRunResponse struct {
	RunID string `json:"run_id"`
}

type ApproveRequest struct {
	StepID string `json:"step_id"`
}

type CreateSessionRequest struct {
	WorkspacePath string `json:"workspace_path"`
	SystemPrompt  string `json:"system_prompt,omitempty"`
	AutoRun       bool   `json:"auto_run,omitempty"`
	Mode          string `json:"mode,omitempty"`
	SpecPath      string `json:"spec_path,omitempty"`
}

type CreateSessionResponse struct {
	SessionID string `json:"session_id"`
	SpecPath  string `json:"spec_path,omitempty"`
}

type UpdateSessionModeRequest struct {
	Mode     string `json:"mode"`
	SpecPath string `json:"spec_path,omitempty"`
}

type UpdateSessionModeResponse struct {
	SessionID string `json:"session_id"`
	Mode      string `json:"mode"`
	SpecPath  string `json:"spec_path,omitempty"`
}

type MessagePart struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Ref      string `json:"ref,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
}

type AddMessageRequest struct {
	Role    string        `json:"role"`
	Parts   []MessagePart `json:"parts"`
	AutoRun bool          `json:"auto_run,omitempty"`
}

type AddMessageResponse struct {
	MessageID string `json:"message_id"`
	TurnID    string `json:"turn_id"`
}

type SessionApproveRequest struct {
	TurnID     string `json:"turn_id"`
	ToolCallID string `json:"tool_call_id"`
	Action     string `json:"action"`
	Reason     string `json:"reason,omitempty"`
}

type AttachmentUploadRequest struct {
	Name          string `json:"name"`
	MimeType      string `json:"mime_type,omitempty"`
	ContentBase64 string `json:"content_base64"`
}

type AttachmentUploadResponse struct {
	Ref      string `json:"ref"`
	MimeType string `json:"mime_type"`
}

type GenerateSpecRequest struct {
	WorkspacePath string `json:"workspace_path"`
	SpecName      string `json:"spec_name"`
	Prompt        string `json:"prompt"`
	Overwrite     bool   `json:"overwrite,omitempty"`
}

type GenerateSpecResponse struct {
	SpecPath string `json:"spec_path"`
	Content  string `json:"content"`
}
