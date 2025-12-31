package runstore

import "time"

type SessionStatus string
type SessionMode string

const (
	SessionActive          SessionStatus = "active"
	SessionWaitingApproval SessionStatus = "waiting_approval"
	SessionCompleted       SessionStatus = "completed"
	SessionFailed          SessionStatus = "failed"
	SessionCanceled        SessionStatus = "canceled"
)

const (
	SessionModeChat SessionMode = "chat"
	SessionModeSpec SessionMode = "spec"
)

type TurnStatus string

const (
	TurnPending         TurnStatus = "pending"
	TurnRunning         TurnStatus = "running"
	TurnWaitingApproval TurnStatus = "waiting_approval"
	TurnSucceeded       TurnStatus = "succeeded"
	TurnFailed          TurnStatus = "failed"
)

type MessagePart struct {
	Type     string `json:"type"` // text|image|audio|file
	Text     string `json:"text,omitempty"`
	Ref      string `json:"ref,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
}

type Message struct {
	ID         string        `json:"id"`
	Role       string        `json:"role"` // system|user|assistant|tool
	Parts      []MessagePart `json:"parts"`
	CreatedAt  time.Time     `json:"created_at"`
	ToolCallID string        `json:"tool_call_id,omitempty"`
}

type Turn struct {
	ID          string     `json:"id"`
	Status      TurnStatus `json:"status"`
	StartedAt   *time.Time `json:"started_at,omitempty"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
	Error       string     `json:"error,omitempty"`
}

type Session struct {
	ID            string        `json:"id"`
	CreatedAt     time.Time     `json:"created_at"`
	UpdatedAt     time.Time     `json:"updated_at"`
	Status        SessionStatus `json:"status"`
	Mode          SessionMode   `json:"mode,omitempty"`
	WorkspacePath string        `json:"workspace_path"`
	SystemPrompt  string        `json:"system_prompt,omitempty"`
	SpecPath      string        `json:"spec_path,omitempty"`
	LastTurnID    string        `json:"last_turn_id,omitempty"`
	Messages      []Message     `json:"messages,omitempty"`
	Turns         []Turn        `json:"turns,omitempty"`
	Error         string        `json:"error,omitempty"`
}

type SessionEvent struct {
	TS        time.Time      `json:"ts"`
	SessionID string         `json:"session_id"`
	TurnID    string         `json:"turn_id,omitempty"`
	Type      string         `json:"type"`
	Message   string         `json:"message,omitempty"`
	Data      map[string]any `json:"data,omitempty"`
}

type ApprovalDecision struct {
	Action string `json:"action"` // approve|deny
	Reason string `json:"reason,omitempty"`
}
