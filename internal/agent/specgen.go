package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	aikit "github.com/Volpestyle/ai-kit/packages/go"
	"github.com/yourorg/coding-agent-harness/internal/config"
)

type SpecGenerator struct {
	Kit    *aikit.Kit
	Router *aikit.ModelRouter
	Policy config.ModelPolicy
}

func (g *SpecGenerator) GenerateSpec(ctx context.Context, workspacePath, specName, prompt string) (string, error) {
	if g.Kit == nil {
		return "", errors.New("kit is nil")
	}
	model, err := g.resolveModel(ctx)
	if err != nil {
		return "", err
	}
	agents, _ := os.ReadFile(filepath.Join(workspacePath, "AGENTS.md"))
	sys := buildSpecPrompt(specName, prompt, string(agents))

	out, err := g.Kit.Generate(ctx, aikit.GenerateInput{
		Provider: model.Provider,
		Model:    model.ProviderModelID,
		Messages: []aikit.Message{{
			Role: "user",
			Content: []aikit.ContentPart{{
				Type: "text",
				Text: sys,
			}},
		}},
	})
	if err != nil {
		return "", err
	}
	content := strings.TrimSpace(out.Text)
	if content == "" {
		return "", errors.New("model returned empty spec")
	}
	if !strings.Contains(content, "# Goal") {
		content = fallbackSpec(specName, prompt)
	}
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	return content, nil
}

func (g *SpecGenerator) resolveModel(ctx context.Context) (aikit.ModelRecord, error) {
	records, err := g.Kit.ListModelRecords(ctx, nil)
	if err != nil {
		return aikit.ModelRecord{}, err
	}
	if g.Router == nil {
		g.Router = &aikit.ModelRouter{}
	}
	resolved, err := g.Router.Resolve(records, aikit.ModelResolutionRequest{
		Constraints: aikit.ModelConstraints{
			RequireTools:  g.Policy.RequireTools,
			RequireVision: g.Policy.RequireVision,
			MaxCostUSD:    g.Policy.MaxCostUSD,
		},
		PreferredModels: g.Policy.PreferredModels,
	})
	if err != nil {
		return aikit.ModelRecord{}, err
	}
	return resolved.Primary, nil
}

func buildSpecPrompt(name, prompt, agents string) string {
	var b strings.Builder
	b.WriteString("You are an expert product/spec writer for a coding agent harness.\n")
	b.WriteString("Return ONLY markdown (no code fences, no commentary).\n")
	b.WriteString("Follow this exact structure:\n")
	b.WriteString("---\n")
	b.WriteString("name: " + name + "\n")
	b.WriteString("owner: you\n")
	b.WriteString("status: draft\n")
	b.WriteString("---\n\n")
	b.WriteString("# Goal\n\n")
	b.WriteString("<one paragraph goal>\n\n")
	b.WriteString("# Constraints / nuances\n\n")
	b.WriteString("- <bullets>\n\n")
	b.WriteString("# Acceptance tests\n\n")
	b.WriteString("- <bulleted, runnable checks>\n\n")
	b.WriteString("# Notes\n\n")
	b.WriteString("- <optional>\n\n")
	b.WriteString("USER PROMPT:\n")
	b.WriteString(prompt)
	b.WriteString("\n\n")
	if strings.TrimSpace(agents) != "" {
		b.WriteString("AGENTS.md:\n")
		b.WriteString(agents)
		b.WriteString("\n\n")
	}
	return b.String()
}

func fallbackSpec(name, prompt string) string {
	return fmt.Sprintf(`---
name: %s
owner: you
status: draft
---

# Goal

%s

# Constraints / nuances

- Follow repo conventions in AGENTS.md.

# Acceptance tests

- make test
`, name, strings.TrimSpace(prompt))
}
