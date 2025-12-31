package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	aikit "github.com/Volpestyle/ai-kit/packages/go"
	"github.com/yourorg/coding-agent-harness/internal/util"
)

type Plan struct {
	Steps []PlanStep `json:"steps"`
}

type PlanStep struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	Type          string `json:"type"`
	NeedsApproval bool   `json:"needs_approval"`
	Command       string `json:"command,omitempty"`
	Patch         string `json:"patch,omitempty"` // unified diff for "patch" steps
}

func DefaultPlan() Plan {
	return Plan{
		Steps: []PlanStep{
			{
				ID:            util.NewStepID(),
				Title:         "Run unit tests",
				Type:          "command",
				NeedsApproval: false,
				Command:       "go test ./...",
			},
			{
				ID:            util.NewStepID(),
				Title:         "Render diagrams (best effort)",
				Type:          "command",
				NeedsApproval: false,
				Command:       "make diagrams",
			},
		},
	}
}

func GeneratePlan(ctx context.Context, kit *aikit.Kit, model aikit.ModelRecord, specText string, bundle ContextBundle) (Plan, error) {
	if kit == nil {
		return DefaultPlan(), errors.New("kit is nil")
	}
	prompt := buildPlanningPrompt(specText, bundle)

	out, err := kit.Generate(ctx, aikit.GenerateInput{
		Provider: model.Provider,
		Model:    model.ProviderModelID,
		Messages: []aikit.Message{{
			Role: "user",
			Content: []aikit.ContentPart{{
				Type: "text",
				Text: prompt,
			}},
		}},
	})
	if err != nil {
		return DefaultPlan(), err
	}

	p, err := parsePlanFromText(out.Text)
	if err != nil {
		// Fall back to a safe default plan if the model didn't comply.
		return DefaultPlan(), nil
	}
	normalizePlan(&p)
	return p, nil
}

func buildPlanningPrompt(specText string, bundle ContextBundle) string {
	var b strings.Builder
	b.WriteString("You are an expert coding-agent planner.\n")
	b.WriteString("Return JSON ONLY (no markdown, no code fences) with this exact schema:\n\n")
	b.WriteString(`{"steps":[{"id":"step_...","title":"...","type":"command|patch|diagram|note","needs_approval":true|false,"command":"...","patch":"..."}]}` + "\n\n")
	b.WriteString("Rules:\n")
	b.WriteString("- Use needs_approval=true for any destructive command or infra change.\n")
	b.WriteString("- Use type=patch with a unified diff in patch when you propose code edits.\n")
	b.WriteString("- Keep the step list short and executable.\n\n")
	b.WriteString("SPEC:\n")
	b.WriteString(specText)
	b.WriteString("\n\n")
	if bundle.AgentsMD != "" {
		b.WriteString("AGENTS.md:\n")
		b.WriteString(bundle.AgentsMD)
		b.WriteString("\n\n")
	}
	if bundle.RepoMap != "" {
		b.WriteString("REPO MAP (symbols):\n")
		b.WriteString(bundle.RepoMap)
		b.WriteString("\n\n")
	}
	if bundle.GitStatus != "" {
		b.WriteString("GIT STATUS:\n")
		b.WriteString(bundle.GitStatus)
		b.WriteString("\n\n")
	}
	return b.String()
}

func parsePlanFromText(s string) (Plan, error) {
	s = strings.TrimSpace(s)
	// Strip code fences if present.
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)

	// Heuristic: find first '{' and last '}'.
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start >= 0 && end > start {
		s = s[start : end+1]
	}

	var p Plan
	if err := json.Unmarshal([]byte(s), &p); err != nil {
		return Plan{}, err
	}
	if len(p.Steps) == 0 {
		return Plan{}, fmt.Errorf("no steps in plan")
	}
	return p, nil
}

func normalizePlan(p *Plan) {
	for i := range p.Steps {
		if strings.TrimSpace(p.Steps[i].ID) == "" {
			p.Steps[i].ID = util.NewStepID()
		}
		if strings.TrimSpace(p.Steps[i].Title) == "" {
			p.Steps[i].Title = p.Steps[i].Type
		}
		if strings.TrimSpace(p.Steps[i].Type) == "" {
			p.Steps[i].Type = "note"
		}
	}
}
