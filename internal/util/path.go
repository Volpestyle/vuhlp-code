package util

import (
	"os"
	"path/filepath"
	"strings"
)

// ExpandHome expands "~/" to the user's home directory if possible.
func ExpandHome(path string) string {
	if path == "" {
		return path
	}
	if strings.HasPrefix(path, "~/") || path == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return path
		}
		if path == "~" {
			return home
		}
		return filepath.Join(home, path[2:])
	}
	return path
}
