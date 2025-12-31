package util

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const DefaultSpecContent = `# Goal

<describe the goal>

# Constraints / nuances

- <constraints>

# Acceptance tests

- <acceptance tests>
`

func DefaultSpecPath(workspacePath, name string) (string, error) {
	if strings.TrimSpace(workspacePath) == "" {
		return "", errors.New("workspace path is empty")
	}
	if strings.TrimSpace(name) == "" {
		return "", errors.New("spec name is empty")
	}
	absWorkspace, err := filepath.Abs(workspacePath)
	if err != nil {
		return "", err
	}
	return filepath.Join(absWorkspace, "specs", name, "spec.md"), nil
}

func EnsureSpecFile(path string) (bool, error) {
	if strings.TrimSpace(path) == "" {
		return false, errors.New("spec path is empty")
	}
	if _, err := os.Stat(path); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	content := DefaultSpecContent
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return false, err
	}
	return true, nil
}
