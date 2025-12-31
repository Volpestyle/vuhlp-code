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
