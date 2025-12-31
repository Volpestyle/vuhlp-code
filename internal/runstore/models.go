package runstore

import "time"

type RunStatus string

const (
	RunQueued          RunStatus = "queued"
	RunRunning         RunStatus = "running"
	RunWaitingApproval RunStatus = "waiting_approval"
	RunSucceeded       RunStatus = "succeeded"
	RunFailed          RunStatus = "failed"
	RunCanceled        RunStatus = "canceled"
)

type StepStatus string

const (
	StepPending   StepStatus = "pending"
	StepRunning   StepStatus = "running"
	StepWaiting   StepStatus = "waiting_approval"
	StepSucceeded StepStatus = "succeeded"
	StepFailed    StepStatus = "failed"
	StepSkipped   StepStatus = "skipped"
)

type Step struct {
	ID            string     `json:"id"`
	Title         string     `json:"title"`
	Type          string     `json:"type"` // "plan" | "command" | "patch" | "diagram" | ...
	NeedsApproval bool       `json:"needs_approval"`
	Command       string     `json:"command,omitempty"`
	Status        StepStatus `json:"status"`
	StartedAt     *time.Time `json:"started_at,omitempty"`
	CompletedAt   *time.Time `json:"completed_at,omitempty"`
}

type Run struct {
	ID            string    `json:"id"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	Status        RunStatus `json:"status"`
	WorkspacePath string    `json:"workspace_path"`
	SpecPath      string    `json:"spec_path"`

	// Chosen model (optional, informational).
	ModelCanonical string `json:"model_canonical,omitempty"`

	Steps []Step `json:"steps,omitempty"`

	Error string `json:"error,omitempty"`
}

type Event struct {
	TS      time.Time      `json:"ts"`
	RunID   string         `json:"run_id"`
	Type    string         `json:"type"` // "log" | "step_started" | "step_completed" | ...
	Message string         `json:"message,omitempty"`
	Data    map[string]any `json:"data,omitempty"`
}
