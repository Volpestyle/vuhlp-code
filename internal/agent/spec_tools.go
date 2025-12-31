package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/yourorg/coding-agent-harness/internal/runstore"
)

type SpecReadTool struct {
	SpecPath string
}

func (t SpecReadTool) Definition() ToolDefinition {
	return ToolDefinition{
		Name:        "read_spec",
		Description: "Read the current spec.md content.",
		Kind:        ToolKindRead,
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	}
}

func (t SpecReadTool) Invoke(ctx context.Context, call ToolCall) (ToolResult, error) {
	content, err := os.ReadFile(t.SpecPath)
	if err != nil {
		return ToolResult{
			ID:    call.ID,
			OK:    false,
			Error: err.Error(),
			Parts: []runstore.MessagePart{{Type: "text", Text: "spec not found"}},
		}, err
	}
	return ToolResult{
		ID:    call.ID,
		OK:    true,
		Parts: []runstore.MessagePart{{Type: "text", Text: string(content)}},
	}, nil
}

type SpecWriteTool struct {
	SpecPath string
}

func (t SpecWriteTool) Definition() ToolDefinition {
	return ToolDefinition{
		Name:                 "write_spec",
		Description:          "Overwrite spec.md with full content.",
		Kind:                 ToolKindWrite,
		AllowWithoutApproval: true,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"content": map[string]any{"type": "string"},
			},
			"required": []string{"content"},
		},
	}
}

func (t SpecWriteTool) Invoke(ctx context.Context, call ToolCall) (ToolResult, error) {
	var input struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(call.Input, &input); err != nil {
		return ToolResult{ID: call.ID, OK: false, Error: "invalid input"}, err
	}
	content := strings.TrimSpace(input.Content)
	if content == "" {
		return ToolResult{ID: call.ID, OK: false, Error: "content is empty"}, errors.New("content is empty")
	}
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	if err := os.MkdirAll(filepath.Dir(t.SpecPath), 0o755); err != nil {
		return ToolResult{ID: call.ID, OK: false, Error: err.Error()}, err
	}
	if err := os.WriteFile(t.SpecPath, []byte(content), 0o644); err != nil {
		return ToolResult{ID: call.ID, OK: false, Error: err.Error()}, err
	}
	return ToolResult{
		ID:    call.ID,
		OK:    true,
		Parts: []runstore.MessagePart{{Type: "text", Text: "spec written"}},
	}, nil
}

type SpecValidateTool struct {
	SpecPath string
}

func (t SpecValidateTool) Definition() ToolDefinition {
	return ToolDefinition{
		Name:        "validate_spec",
		Description: "Validate spec.md structure (Goal, Constraints, Acceptance tests).",
		Kind:        ToolKindRead,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"content": map[string]any{"type": "string"},
			},
		},
	}
}

func (t SpecValidateTool) Invoke(ctx context.Context, call ToolCall) (ToolResult, error) {
	var input struct {
		Content string `json:"content"`
	}
	_ = json.Unmarshal(call.Input, &input)

	content := strings.TrimSpace(input.Content)
	if content == "" {
		b, err := os.ReadFile(t.SpecPath)
		if err != nil {
			return ToolResult{ID: call.ID, OK: false, Error: err.Error()}, err
		}
		content = string(b)
	}
	ok, problems := ValidateSpecContent(content)
	payload := map[string]any{
		"ok":       ok,
		"problems": problems,
	}
	text := fmt.Sprintf("ok=%v\n", ok)
	if len(problems) > 0 {
		text += strings.Join(problems, "\n")
	}
	return ToolResult{
		ID:    call.ID,
		OK:    ok,
		Error: joinProblems(problems),
		Parts: []runstore.MessagePart{
			{Type: "text", Text: text},
			{Type: "text", Text: toJSON(payload)},
		},
	}, nil
}

func ValidateSpecContent(content string) (bool, []string) {
	lines := strings.Split(content, "\n")
	hasGoal := false
	hasConstraints := false
	hasAcceptance := false

	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if !strings.HasPrefix(trim, "#") {
			continue
		}
		title := strings.TrimSpace(strings.TrimLeft(trim, "#"))
		if title == "" {
			continue
		}
		lower := strings.ToLower(title)
		if strings.HasPrefix(lower, "goal") {
			hasGoal = true
		}
		if strings.Contains(lower, "constraint") {
			hasConstraints = true
		}
		if strings.Contains(lower, "acceptance") {
			hasAcceptance = true
		}
	}

	var problems []string
	if !hasGoal {
		problems = append(problems, "missing heading: # Goal")
	}
	if !hasConstraints {
		problems = append(problems, "missing heading: # Constraints / nuances")
	}
	if !hasAcceptance {
		problems = append(problems, "missing heading: # Acceptance tests")
	}
	return len(problems) == 0, problems
}

func joinProblems(problems []string) string {
	if len(problems) == 0 {
		return ""
	}
	return strings.Join(problems, "; ")
}
