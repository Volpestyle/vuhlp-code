package util

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type WalkOptions struct {
	MaxFiles     int
	MaxDepth     int
	SkipDirNames map[string]bool
}

func DefaultWalkOptions() WalkOptions {
	return WalkOptions{
		MaxFiles: 5000,
		MaxDepth: 30,
		SkipDirNames: map[string]bool{
			".git":                true,
			"node_modules":        true,
			"vendor":              true,
			"dist":                true,
			"build":               true,
			"bin":                 true,
			".agent-harness":      true,
			".agent-harness-cache": true,
		},
	}
}

// WalkFiles returns relative file paths under root (excluding directories).
func WalkFiles(root string, opts WalkOptions) ([]string, error) {
	if opts.MaxFiles <= 0 {
		return nil, errors.New("MaxFiles must be > 0")
	}
	if opts.MaxDepth <= 0 {
		opts.MaxDepth = 30
	}
	var out []string

	root = filepath.Clean(root)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// Keep walking; report later if needed.
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)

		// Depth check.
		if rel != "." {
			depth := strings.Count(rel, "/") + 1
			if depth > opts.MaxDepth {
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
		}

		// Skip dirs.
		if d.IsDir() {
			name := d.Name()
			if opts.SkipDirNames != nil && opts.SkipDirNames[name] {
				return fs.SkipDir
			}
			return nil
		}

		// Only regular files.
		info, statErr := d.Info()
		if statErr == nil && !info.Mode().IsRegular() {
			return nil
		}

		if rel == "." {
			return nil
		}
		out = append(out, rel)
		if len(out) >= opts.MaxFiles {
			return errors.New("max files reached")
		}
		return nil
	})

	if err != nil && strings.Contains(err.Error(), "max files reached") {
		// Not fatal.
		return out, nil
	}
	// If root doesn't exist, error early.
	if _, statErr := os.Stat(root); statErr != nil {
		return nil, statErr
	}
	return out, nil
}
