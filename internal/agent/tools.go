package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	aikit "github.com/Volpestyle/ai-kit/packages/go"
	"github.com/yourorg/coding-agent-harness/internal/runstore"
	"github.com/yourorg/coding-agent-harness/internal/util"
)

type ToolKind string

const (
	ToolKindRead  ToolKind = "read"
	ToolKindWrite ToolKind = "write"
	ToolKindExec  ToolKind = "exec"
	ToolKindNet   ToolKind = "network"
)

type ToolDefinition struct {
	Name                 string
	Description          string
	Parameters           map[string]any
	Kind                 ToolKind
	RequiresApproval     bool
	AllowWithoutApproval bool
}

type ToolCall struct {
	ID    string
	Name  string
	Input json.RawMessage
}

type ToolResult struct {
	ID        string
	OK        bool
	Parts     []runstore.MessagePart
	Artifacts []string
	Error     string
}

type Tool interface {
	Definition() ToolDefinition
	Invoke(ctx context.Context, call ToolCall) (ToolResult, error)
}

type ToolRegistry interface {
	Definitions() []ToolDefinition
	Invoke(ctx context.Context, call ToolCall) (ToolResult, error)
	Get(name string) (Tool, bool)
	Add(tool Tool)
}

type Registry struct {
	tools map[string]Tool
}

func DefaultToolRegistry(workspace string, verify VerifyPolicy) ToolRegistry {
	commands := verify.Commands
	if len(commands) == 0 {
		commands = []string{"make test"}
	}
	return NewRegistry(
		RepoTreeTool{Workspace: workspace, MaxFiles: 500},
		RepoMapTool{Workspace: workspace, MaxSymbols: 400},
		ReadFileTool{Workspace: workspace, MaxLines: 400},
		SearchTool{Workspace: workspace, MaxResults: 50},
		GitStatusTool{Workspace: workspace},
		ApplyPatchTool{Workspace: workspace},
		ShellTool{Workspace: workspace, Timeout: 30 * time.Minute},
		DiagramTool{Workspace: workspace},
		VerifyTool{Workspace: workspace, Commands: commands, Timeout: 30 * time.Minute},
	)
}

func NewRegistry(tools ...Tool) *Registry {
	reg := &Registry{tools: map[string]Tool{}}
	for _, tool := range tools {
		if tool == nil {
			continue
		}
		reg.tools[tool.Definition().Name] = tool
	}
	return reg
}

func (r *Registry) Add(tool Tool) {
	if tool == nil {
		return
	}
	r.tools[tool.Definition().Name] = tool
}

func (r *Registry) Definitions() []ToolDefinition {
	out := make([]ToolDefinition, 0, len(r.tools))
	for _, tool := range r.tools {
		out = append(out, tool.Definition())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (r *Registry) Invoke(ctx context.Context, call ToolCall) (ToolResult, error) {
	tool, ok := r.tools[call.Name]
	if !ok {
		return ToolResult{ID: call.ID, OK: false, Error: "unknown tool"}, fmt.Errorf("unknown tool: %s", call.Name)
	}
	return tool.Invoke(ctx, call)
}

func (r *Registry) Get(name string) (Tool, bool) {
	tool, ok := r.tools[name]
	return tool, ok
}

type AikitAdapter struct{}

func (a AikitAdapter) ToAikitTools(defs []ToolDefinition) []aikit.ToolDefinition {
	out := make([]aikit.ToolDefinition, 0, len(defs))
	for _, def := range defs {
		params := def.Parameters
		if params == nil {
			params = map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			}
		}
		out = append(out, aikit.ToolDefinition{
			Name:        def.Name,
			Description: def.Description,
			Parameters:  params,
		})
	}
	return out
}

func (a AikitAdapter) FromAikitCall(call aikit.ToolCall) ToolCall {
	raw := strings.TrimSpace(call.ArgumentsJSON)
	if raw == "" {
		raw = "{}"
	}
	return ToolCall{
		ID:    call.ID,
		Name:  call.Name,
		Input: json.RawMessage(raw),
	}
}

func toJSON(data any) string {
	b, _ := json.MarshalIndent(data, "", "  ")
	return string(b)
}

func safeWorkspacePath(workspace, rel string) (string, error) {
	if strings.TrimSpace(rel) == "" {
		return "", errors.New("path is empty")
	}
	workspace = filepath.Clean(workspace)
	abs := filepath.Clean(filepath.Join(workspace, rel))
	relPath, err := filepath.Rel(workspace, abs)
	if err != nil {
		return "", err
	}
	if relPath == ".." || strings.HasPrefix(relPath, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("path escapes workspace: %s", rel)
	}
	return abs, nil
}

type RepoTreeTool struct {
	Workspace string
	MaxFiles  int
}

func (t RepoTreeTool) Definition() ToolDefinition {
	return ToolDefinition{
		Name:        "repo_tree",
		Description: "List files in the workspace (relative paths).",
		Kind:        ToolKindRead,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"max_files": map[string]any{"type": "integer"},
			},
		},
	}
}

func (t RepoTreeTool) Invoke(ctx context.Context, call ToolCall) (ToolResult, error) {
	maxFiles := t.MaxFiles
	var input struct {
		MaxFiles int `json:"max_files"`
	}
	_ = json.Unmarshal(call.Input, &input)
	if input.MaxFiles > 0 {
		maxFiles = input.MaxFiles
	}
	files, err := util.WalkFiles(t.Workspace, util.DefaultWalkOptions())
	if err != nil {
		return ToolResult{ID: call.ID, OK: false, Error: err.Error()}, err
	}
	if maxFiles > 0 && len(files) > maxFiles {
		files = files[:maxFiles]
	}
	return ToolResult{
		ID:    call.ID,
		OK:    true,
		Parts: []runstore.MessagePart{{Type: "text", Text: strings.Join(files, "\n")}},
	}, nil
}

type RepoMapTool struct {
	Workspace  string
	MaxSymbols int
}

func (t RepoMapTool) Definition() ToolDefinition {
	return ToolDefinition{
		Name:        "repo_map",
		Description: "List symbols in the repo (Go/Python/JS/TS).",
		Kind:        ToolKindRead,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"max_symbols": map[string]any{"type": "integer"},
			},
		},
	}
}

func (t RepoMapTool) Invoke(ctx context.Context, call ToolCall) (ToolResult, error) {
	maxSymbols := t.MaxSymbols
	var input struct {
		MaxSymbols int `json:"max_symbols"`
	}
	_ = json.Unmarshal(call.Input, &input)
	if input.MaxSymbols > 0 {
		maxSymbols = input.MaxSymbols
	}
	files, err := util.WalkFiles(t.Workspace, util.DefaultWalkOptions())
	if err != nil {
		return ToolResult{ID: call.ID, OK: false, Error: err.Error()}, err
	}
	if maxSymbols <= 0 {
		maxSymbols = 400
	}
	out := buildRepoMap(t.Workspace, files, maxSymbols)
	return ToolResult{
		ID:    call.ID,
		OK:    true,
		Parts: []runstore.MessagePart{{Type: "text", Text: out}},
	}, nil
}

type ReadFileTool struct {
	Workspace string
	MaxLines  int
}

func (t ReadFileTool) Definition() ToolDefinition {
	return ToolDefinition{
		Name:        "read_file",
		Description: "Read a file from the workspace with optional line range.",
		Kind:        ToolKindRead,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":       map[string]any{"type": "string"},
				"start_line": map[string]any{"type": "integer"},
				"end_line":   map[string]any{"type": "integer"},
			},
			"required": []string{"path"},
		},
	}
}

func (t ReadFileTool) Invoke(ctx context.Context, call ToolCall) (ToolResult, error) {
	var input struct {
		Path      string `json:"path"`
		StartLine int    `json:"start_line"`
		EndLine   int    `json:"end_line"`
	}
	if err := json.Unmarshal(call.Input, &input); err != nil {
		return ToolResult{ID: call.ID, OK: false, Error: "invalid input"}, err
	}
	abs, err := safeWorkspacePath(t.Workspace, input.Path)
	if err != nil {
		return ToolResult{ID: call.ID, OK: false, Error: err.Error()}, err
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return ToolResult{ID: call.ID, OK: false, Error: err.Error()}, err
	}
	lines := strings.Split(string(b), "\n")
	start := 1
	if input.StartLine > 0 {
		start = input.StartLine
	}
	end := len(lines)
	if input.EndLine > 0 && input.EndLine < end {
		end = input.EndLine
	}
	if start < 1 {
		start = 1
	}
	if start > end {
		start = end
	}
	if t.MaxLines > 0 && end-start+1 > t.MaxLines {
		end = start + t.MaxLines - 1
		if end > len(lines) {
			end = len(lines)
		}
	}
	snippet := strings.Join(lines[start-1:end], "\n")
	return ToolResult{
		ID: call.ID,
		OK: true,
		Parts: []runstore.MessagePart{{
			Type: "text",
			Text: snippet,
		}},
	}, nil
}

type SearchTool struct {
	Workspace  string
	MaxResults int
}

func (t SearchTool) Definition() ToolDefinition {
	return ToolDefinition{
		Name:        "search",
		Description: "Search for a substring in files.",
		Kind:        ToolKindRead,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":       map[string]any{"type": "string"},
				"glob":        map[string]any{"type": "string"},
				"max_results": map[string]any{"type": "integer"},
			},
			"required": []string{"query"},
		},
	}
}

func (t SearchTool) Invoke(ctx context.Context, call ToolCall) (ToolResult, error) {
	var input struct {
		Query      string `json:"query"`
		Glob       string `json:"glob"`
		MaxResults int    `json:"max_results"`
	}
	if err := json.Unmarshal(call.Input, &input); err != nil {
		return ToolResult{ID: call.ID, OK: false, Error: "invalid input"}, err
	}
	query := strings.TrimSpace(input.Query)
	if query == "" {
		return ToolResult{ID: call.ID, OK: false, Error: "query required"}, errors.New("query required")
	}
	maxResults := t.MaxResults
	if input.MaxResults > 0 {
		maxResults = input.MaxResults
	}
	if maxResults <= 0 {
		maxResults = 50
	}
	files, err := util.WalkFiles(t.Workspace, util.DefaultWalkOptions())
	if err != nil {
		return ToolResult{ID: call.ID, OK: false, Error: err.Error()}, err
	}
	var matches []string
	for _, rel := range files {
		if len(matches) >= maxResults {
			break
		}
		if input.Glob != "" {
			if ok, _ := filepath.Match(input.Glob, filepath.Base(rel)); !ok {
				continue
			}
		}
		abs := filepath.Join(t.Workspace, filepath.FromSlash(rel))
		b, err := os.ReadFile(abs)
		if err != nil {
			continue
		}
		lines := strings.Split(string(b), "\n")
		for i, line := range lines {
			if strings.Contains(line, query) {
				matches = append(matches, fmt.Sprintf("%s:%d:%s", rel, i+1, strings.TrimSpace(line)))
				if len(matches) >= maxResults {
					break
				}
			}
		}
	}
	return ToolResult{
		ID:    call.ID,
		OK:    true,
		Parts: []runstore.MessagePart{{Type: "text", Text: strings.Join(matches, "\n")}},
	}, nil
}

type GitStatusTool struct {
	Workspace string
}

func (t GitStatusTool) Definition() ToolDefinition {
	return ToolDefinition{
		Name:        "git_status",
		Description: "Return git status --porcelain for the workspace.",
		Kind:        ToolKindRead,
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	}
}

func (t GitStatusTool) Invoke(ctx context.Context, call ToolCall) (ToolResult, error) {
	res, err := util.RunCommand(ctx, "git status --porcelain", util.ExecOptions{
		Dir:     t.Workspace,
		Timeout: 10 * time.Second,
	})
	if err != nil {
		return ToolResult{ID: call.ID, OK: false, Error: err.Error()}, err
	}
	return ToolResult{
		ID:    call.ID,
		OK:    true,
		Parts: []runstore.MessagePart{{Type: "text", Text: strings.TrimSpace(res.Stdout)}},
	}, nil
}

type ApplyPatchTool struct {
	Workspace string
}

func (t ApplyPatchTool) Definition() ToolDefinition {
	return ToolDefinition{
		Name:             "apply_patch",
		Description:      "Apply a unified diff patch using git apply.",
		Kind:             ToolKindWrite,
		RequiresApproval: true,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"patch": map[string]any{"type": "string"},
			},
			"required": []string{"patch"},
		},
	}
}

func (t ApplyPatchTool) Invoke(ctx context.Context, call ToolCall) (ToolResult, error) {
	var input struct {
		Patch string `json:"patch"`
	}
	if err := json.Unmarshal(call.Input, &input); err != nil {
		return ToolResult{ID: call.ID, OK: false, Error: "invalid input"}, err
	}
	res, err := util.ApplyUnifiedDiff(ctx, t.Workspace, input.Patch)
	out := toJSON(res)
	if err != nil {
		return ToolResult{
			ID:    call.ID,
			OK:    false,
			Error: err.Error(),
			Parts: []runstore.MessagePart{{Type: "text", Text: out}},
		}, err
	}
	return ToolResult{
		ID:    call.ID,
		OK:    true,
		Parts: []runstore.MessagePart{{Type: "text", Text: out}},
	}, nil
}

type ShellTool struct {
	Workspace string
	Timeout   time.Duration
}

func (t ShellTool) Definition() ToolDefinition {
	return ToolDefinition{
		Name:             "shell",
		Description:      "Run a shell command in the workspace.",
		Kind:             ToolKindExec,
		RequiresApproval: true,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command":         map[string]any{"type": "string"},
				"timeout_seconds": map[string]any{"type": "integer"},
			},
			"required": []string{"command"},
		},
	}
}

func (t ShellTool) Invoke(ctx context.Context, call ToolCall) (ToolResult, error) {
	var input struct {
		Command        string `json:"command"`
		TimeoutSeconds int    `json:"timeout_seconds"`
	}
	if err := json.Unmarshal(call.Input, &input); err != nil {
		return ToolResult{ID: call.ID, OK: false, Error: "invalid input"}, err
	}
	timeout := t.Timeout
	if input.TimeoutSeconds > 0 {
		timeout = time.Duration(input.TimeoutSeconds) * time.Second
	}
	res, err := util.RunCommand(ctx, input.Command, util.ExecOptions{
		Dir:     t.Workspace,
		Timeout: timeout,
	})
	out := toJSON(res)
	if err != nil {
		return ToolResult{
			ID:    call.ID,
			OK:    false,
			Error: err.Error(),
			Parts: []runstore.MessagePart{{Type: "text", Text: out}},
		}, err
	}
	return ToolResult{
		ID:    call.ID,
		OK:    true,
		Parts: []runstore.MessagePart{{Type: "text", Text: out}},
	}, nil
}

type DiagramTool struct {
	Workspace string
}

func (t DiagramTool) Definition() ToolDefinition {
	return ToolDefinition{
		Name:             "diagram",
		Description:      "Render diagrams using make diagrams.",
		Kind:             ToolKindExec,
		RequiresApproval: true,
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	}
}

func (t DiagramTool) Invoke(ctx context.Context, call ToolCall) (ToolResult, error) {
	res, err := util.RunCommand(ctx, "make diagrams", util.ExecOptions{
		Dir:     t.Workspace,
		Timeout: 30 * time.Minute,
	})
	out := toJSON(res)
	if err != nil {
		return ToolResult{
			ID:    call.ID,
			OK:    false,
			Error: err.Error(),
			Parts: []runstore.MessagePart{{Type: "text", Text: out}},
		}, err
	}
	return ToolResult{
		ID:    call.ID,
		OK:    true,
		Parts: []runstore.MessagePart{{Type: "text", Text: out}},
	}, nil
}

type VerifyTool struct {
	Workspace string
	Commands  []string
	Timeout   time.Duration
}

func (t VerifyTool) Definition() ToolDefinition {
	return ToolDefinition{
		Name:        "verify",
		Description: "Run verification commands.",
		Kind:        ToolKindExec,
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	}
}

func (t VerifyTool) Invoke(ctx context.Context, call ToolCall) (ToolResult, error) {
	if len(t.Commands) == 0 {
		t.Commands = []string{"make test"}
	}
	timeout := t.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	results := make([]map[string]any, 0, len(t.Commands))
	ok := true
	for _, cmd := range t.Commands {
		res, err := util.RunCommand(ctx, cmd, util.ExecOptions{
			Dir:     t.Workspace,
			Timeout: timeout,
		})
		results = append(results, map[string]any{
			"cmd":       res.Cmd,
			"exit_code": res.ExitCode,
			"stdout":    res.Stdout,
			"stderr":    res.Stderr,
			"duration":  res.Duration,
		})
		if err != nil {
			ok = false
		}
	}
	out := toJSON(results)
	if !ok {
		return ToolResult{
			ID:    call.ID,
			OK:    false,
			Error: "verification failed",
			Parts: []runstore.MessagePart{{Type: "text", Text: out}},
		}, errors.New("verification failed")
	}
	return ToolResult{
		ID:    call.ID,
		OK:    true,
		Parts: []runstore.MessagePart{{Type: "text", Text: out}},
	}, nil
}
