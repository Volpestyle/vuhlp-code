package agent

import (
	"bytes"
	"context"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/yourorg/coding-agent-harness/internal/util"
)

type ContextBundle struct {
	AgentsMD    string    `json:"agents_md,omitempty"`
	RepoTree    string    `json:"repo_tree,omitempty"`
	RepoMap     string    `json:"repo_map,omitempty"`
	GitStatus   string    `json:"git_status,omitempty"`
	Workspace   string    `json:"workspace,omitempty"`
	GeneratedAt time.Time `json:"generated_at"`
}

// GatherContext builds a lightweight context bundle for prompting.
// It is designed to be fast and stable (no embeddings required).
func GatherContext(ctx context.Context, workspace string) (ContextBundle, error) {
	b := ContextBundle{
		Workspace:   workspace,
		GeneratedAt: time.Now().UTC(),
	}

	// AGENTS.md is optional but strongly encouraged.
	if txt, err := os.ReadFile(filepath.Join(workspace, "AGENTS.md")); err == nil {
		b.AgentsMD = string(txt)
	}

	files, err := util.WalkFiles(workspace, util.DefaultWalkOptions())
	if err != nil {
		return b, err
	}

	// Repo tree (first N files).
	const maxTree = 500
	tree := files
	if len(tree) > maxTree {
		tree = tree[:maxTree]
	}
	b.RepoTree = strings.Join(tree, "\n")

	// Repo map (symbols).
	b.RepoMap = buildRepoMap(workspace, files, 400)

	// Git status (best effort).
	if _, err := os.Stat(filepath.Join(workspace, ".git")); err == nil {
		res, _ := util.RunCommand(ctx, "git status --porcelain", util.ExecOptions{
			Dir:     workspace,
			Timeout: 10 * time.Second,
		})
		b.GitStatus = strings.TrimSpace(res.Stdout)
	}

	return b, nil
}

func buildRepoMap(workspace string, files []string, maxSymbols int) string {
	type sym struct {
		File string
		Line int
		Name string
		Kind string
	}
	var syms []sym

	rePy := regexp.MustCompile(`^(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b`)
	reJS := regexp.MustCompile(`^(export\s+)?(async\s+)?(function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b`)
	reJS2 := regexp.MustCompile(`^(export\s+)?(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*`)

	for _, rel := range files {
		if len(syms) >= maxSymbols {
			break
		}
		ext := strings.ToLower(filepath.Ext(rel))
		abs := filepath.Join(workspace, filepath.FromSlash(rel))

		switch ext {
		case ".go":
			fset := token.NewFileSet()
			parsed, err := parser.ParseFile(fset, abs, nil, parser.ParseComments)
			if err != nil {
				continue
			}
			for _, d := range parsed.Decls {
				switch dd := d.(type) {
				case *ast.FuncDecl:
					pos := fset.Position(dd.Pos())
					name := dd.Name.Name
					syms = append(syms, sym{File: rel, Line: pos.Line, Name: name, Kind: "func"})
				case *ast.GenDecl:
					for _, spec := range dd.Specs {
						switch ss := spec.(type) {
						case *ast.TypeSpec:
							pos := fset.Position(ss.Pos())
							syms = append(syms, sym{File: rel, Line: pos.Line, Name: ss.Name.Name, Kind: "type"})
						case *ast.ValueSpec:
							pos := fset.Position(ss.Pos())
							for _, n := range ss.Names {
								syms = append(syms, sym{File: rel, Line: pos.Line, Name: n.Name, Kind: "var"})
							}
						}
					}
				}
				if len(syms) >= maxSymbols {
					break
				}
			}

		case ".py", ".js", ".ts", ".tsx", ".jsx":
			b, err := os.ReadFile(abs)
			if err != nil {
				continue
			}
			// Only scan first 300 lines for speed.
			lines := bytes.Split(b, []byte("\n"))
			if len(lines) > 300 {
				lines = lines[:300]
			}
			for i, raw := range lines {
				if len(syms) >= maxSymbols {
					break
				}
				line := strings.TrimSpace(string(raw))
				if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "//") {
					continue
				}
				if ext == ".py" {
					m := rePy.FindStringSubmatch(line)
					if len(m) == 3 {
						syms = append(syms, sym{File: rel, Line: i + 1, Name: m[2], Kind: m[1]})
					}
				} else {
					m := reJS.FindStringSubmatch(line)
					if len(m) == 5 {
						syms = append(syms, sym{File: rel, Line: i + 1, Name: m[4], Kind: m[3]})
						continue
					}
					m2 := reJS2.FindStringSubmatch(line)
					if len(m2) == 4 {
						syms = append(syms, sym{File: rel, Line: i + 1, Name: m2[3], Kind: m2[2]})
					}
				}
			}
		}
	}

	sort.Slice(syms, func(i, j int) bool {
		if syms[i].File == syms[j].File {
			return syms[i].Line < syms[j].Line
		}
		return syms[i].File < syms[j].File
	})

	var out strings.Builder
	lastFile := ""
	for _, s := range syms {
		if s.File != lastFile {
			if lastFile != "" {
				out.WriteString("\n")
			}
			out.WriteString(fmt.Sprintf("%s:\n", s.File))
			lastFile = s.File
		}
		out.WriteString(fmt.Sprintf("  - %s %s (line %d)\n", s.Kind, s.Name, s.Line))
	}
	return strings.TrimSpace(out.String())
}
