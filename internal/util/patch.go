package util

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var ErrNotGitRepo = errors.New("workspace is not a git repository (.git not found)")

type PatchApplyResult struct {
	Applied bool   `json:"applied"`
	Stdout  string `json:"stdout,omitempty"`
	Stderr  string `json:"stderr,omitempty"`
}

// ApplyUnifiedDiff applies a unified diff using `git apply`.
// This is intentionally conservative: if the workspace isn't a git repo, it returns ErrNotGitRepo.
func ApplyUnifiedDiff(ctx context.Context, workspace string, diff string) (PatchApplyResult, error) {
	if strings.TrimSpace(diff) == "" {
		return PatchApplyResult{Applied: false}, errors.New("diff is empty")
	}
	workspace = filepath.Clean(workspace)
	if _, err := os.Stat(filepath.Join(workspace, ".git")); err != nil {
		return PatchApplyResult{}, ErrNotGitRepo
	}

	// Use a short timeout for patch application.
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", "apply", "--whitespace=nowarn", "-")
	cmd.Dir = workspace
	cmd.Stdin = strings.NewReader(diff)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		return PatchApplyResult{
			Applied: false,
			Stdout:  stdout.String(),
			Stderr:  stderr.String(),
		}, err
	}
	return PatchApplyResult{
		Applied: true,
		Stdout:  stdout.String(),
		Stderr:  stderr.String(),
	}, nil
}
