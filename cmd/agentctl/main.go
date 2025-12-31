package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yourorg/coding-agent-harness/internal/util"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "init":
		cmdInit(os.Args[2:])
	case "spec":
		cmdSpec(os.Args[2:])
	case "run":
		cmdRun(os.Args[2:])
	case "attach":
		cmdAttach(os.Args[2:])
	case "approve":
		cmdApprove(os.Args[2:])
	case "list":
		cmdList(os.Args[2:])
	case "export":
		cmdExport(os.Args[2:])
	case "doctor":
		cmdDoctor(os.Args[2:])
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Print(`agentctl - CLI client for agentd

Usage:
  agentctl init [--force]
  agentctl spec new <name>
  agentctl run --workspace <path> --spec <path> [--url <base>]
  agentctl attach <run_id> [--url <base>]
  agentctl approve <run_id> --step <step_id> [--url <base>]
  agentctl list [--url <base>]
  agentctl export <run_id> --out <file.zip> [--url <base>]
  agentctl doctor

Environment:
  HARNESS_URL         Base URL for agentd (default http://127.0.0.1:8787)
  HARNESS_AUTH_TOKEN  Bearer token (optional, must match agentd)
`)
}

func baseURL(flagURL string) string {
	if strings.TrimSpace(flagURL) != "" {
		return strings.TrimRight(flagURL, "/")
	}
	if env := os.Getenv("HARNESS_URL"); env != "" {
		return strings.TrimRight(env, "/")
	}
	return "http://127.0.0.1:8787"
}

func authToken() string { return strings.TrimSpace(os.Getenv("HARNESS_AUTH_TOKEN")) }

func httpClient() *http.Client {
	return &http.Client{Timeout: 60 * time.Second}
}

func doJSON(method, url string, body any, out any) error {
	var buf io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		buf = bytes.NewReader(b)
	}

	req, err := http.NewRequest(method, url, buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if tok := authToken(); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}

	resp, err := httpClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func cmdInit(args []string) {
	fs := flag.NewFlagSet("init", flag.ExitOnError)
	force := fs.Bool("force", false, "overwrite existing files")
	_ = fs.Parse(args)

	cwd, _ := os.Getwd()

	write := func(rel, content string) error {
		path := filepath.Join(cwd, rel)
		if !*force {
			if _, err := os.Stat(path); err == nil {
				fmt.Printf("[init] exists, skipping: %s\n", rel)
				return nil
			}
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		return os.WriteFile(path, []byte(content), 0o644)
	}

	agents := `# AGENTS.md

Project-specific instructions for coding agents.

## Build
- go test ./...

## Safety
- Destructive commands require approval.
`
	_ = write("AGENTS.md", agents)

	_ = write("docs/diagrams/README.md", "Diagram sources (.mmd/.dac) and exported PNGs live here.\n")
	_ = write("docs/diagrams/agent-harness.mmd", "flowchart LR\n  A[spec]-->B[agent]\n")
	_ = write("specs/README.md", "# Specs\n\nSpecs live in specs/<name>/spec.md\n")
	_ = write("specs/example/spec.md", "# Example spec\n\nDescribe the goal + acceptance tests.\n")

	fmt.Println("[init] done")
}

func cmdSpec(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "spec requires a subcommand (new)")
		os.Exit(2)
	}
	switch args[0] {
	case "new":
		cmdSpecNew(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "unknown spec subcommand: %s\n", args[0])
		os.Exit(2)
	}
}

func cmdSpecNew(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: agentctl spec new <name>")
		os.Exit(2)
	}
	name := args[0]
	cwd, _ := os.Getwd()
	dir := filepath.Join(cwd, "specs", name)
	if err := os.MkdirAll(filepath.Join(dir, "diagrams"), 0o755); err != nil {
		die(err)
	}
	specPath := filepath.Join(dir, "spec.md")
	if _, err := os.Stat(specPath); err == nil {
		fmt.Printf("[spec] exists: %s\n", specPath)
		return
	}

	spec := fmt.Sprintf(`---
name: %s
status: draft
---

# Goal

Describe what you want built.

# Constraints

- Any AWS/IaC changes require approval.

# Acceptance tests

- go test ./...
`, name)

	if err := os.WriteFile(specPath, []byte(spec), 0o644); err != nil {
		die(err)
	}

	mmd := "flowchart LR\n  A[idea]-->B[done]\n"
	_ = os.WriteFile(filepath.Join(dir, "diagrams", "diagram.mmd"), []byte(mmd), 0o644)

	fmt.Printf("[spec] created: %s\n", specPath)
}

func cmdRun(args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	workspace := fs.String("workspace", ".", "workspace path")
	spec := fs.String("spec", "", "spec file path")
	url := fs.String("url", "", "agentd base url")
	_ = fs.Parse(args)

	if strings.TrimSpace(*spec) == "" {
		die(errors.New("--spec is required"))
	}

	wsAbs, err := filepath.Abs(*workspace)
	if err != nil {
		die(err)
	}
	specAbs, err := filepath.Abs(*spec)
	if err != nil {
		die(err)
	}

	var resp struct {
		RunID string `json:"run_id"`
	}
	err = doJSON("POST", baseURL(*url)+"/v1/runs", map[string]string{
		"workspace_path": wsAbs,
		"spec_path":      specAbs,
	}, &resp)
	if err != nil {
		die(err)
	}
	fmt.Println(resp.RunID)
}

func cmdAttach(args []string) {
	fs := flag.NewFlagSet("attach", flag.ExitOnError)
	url := fs.String("url", "", "agentd base url")
	_ = fs.Parse(args)
	if fs.NArg() < 1 {
		die(errors.New("usage: agentctl attach <run_id>"))
	}
	runID := fs.Arg(0)

	req, err := http.NewRequest("GET", baseURL(*url)+"/v1/runs/"+runID+"/events", nil)
	if err != nil {
		die(err)
	}
	if tok := authToken(); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}

	resp, err := httpClient().Do(req)
	if err != nil {
		die(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		die(fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(b))))
	}

	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "data: ") {
			payload := strings.TrimPrefix(line, "data: ")
			var ev map[string]any
			if err := json.Unmarshal([]byte(payload), &ev); err != nil {
				fmt.Println(payload)
				continue
			}
			printEvent(ev)
		}
	}
	if err := sc.Err(); err != nil {
		die(err)
	}
}

func printEvent(ev map[string]any) {
	ts, _ := ev["ts"].(string)
	typ, _ := ev["type"].(string)
	msg, _ := ev["message"].(string)
	if msg == "" {
		msg = "-"
	}
	fmt.Printf("%s  %-22s  %s\n", ts, typ, msg)
}

func cmdApprove(args []string) {
	fs := flag.NewFlagSet("approve", flag.ExitOnError)
	step := fs.String("step", "", "step id to approve")
	url := fs.String("url", "", "agentd base url")
	_ = fs.Parse(args)

	if fs.NArg() < 1 || strings.TrimSpace(*step) == "" {
		die(errors.New("usage: agentctl approve <run_id> --step <step_id>"))
	}
	runID := fs.Arg(0)

	err := doJSON("POST", baseURL(*url)+"/v1/runs/"+runID+"/approve", map[string]string{
		"step_id": *step,
	}, nil)
	if err != nil {
		die(err)
	}
	fmt.Println("ok")
}

func cmdList(args []string) {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	url := fs.String("url", "", "agentd base url")
	_ = fs.Parse(args)

	var runs []map[string]any
	if err := doJSON("GET", baseURL(*url)+"/v1/runs", nil, &runs); err != nil {
		die(err)
	}
	for _, r := range runs {
		fmt.Printf("%s  %-18s  %s\n", r["id"], r["status"], r["spec_path"])
	}
}

func cmdExport(args []string) {
	fs := flag.NewFlagSet("export", flag.ExitOnError)
	out := fs.String("out", "", "output zip path")
	url := fs.String("url", "", "agentd base url")
	_ = fs.Parse(args)

	if fs.NArg() < 1 || strings.TrimSpace(*out) == "" {
		die(errors.New("usage: agentctl export <run_id> --out <file.zip>"))
	}
	runID := fs.Arg(0)

	req, err := http.NewRequest("GET", baseURL(*url)+"/v1/runs/"+runID+"/export", nil)
	if err != nil {
		die(err)
	}
	if tok := authToken(); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := httpClient().Do(req)
	if err != nil {
		die(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		die(fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(b))))
	}

	f, err := os.Create(*out)
	if err != nil {
		die(err)
	}
	defer f.Close()
	if _, err := io.Copy(f, resp.Body); err != nil {
		die(err)
	}
	fmt.Printf("wrote %s\n", *out)
}

func cmdDoctor(args []string) {
	fmt.Println("doctor:")
	check("git")
	check("rg (ripgrep)")
	check("mmdc (mermaid-cli)")
	check("awsdac (diagram-as-code)")
	fmt.Println("notes:")
	fmt.Println("- For Mermaid diagrams, you can also use `npx -y @mermaid-js/mermaid-cli`.")
	fmt.Println("- For remote cockpit, prefer an authenticated tunnel (Tailscale/Cloudflare).")
}

func check(cmd string) {
	name := strings.Split(cmd, " ")[0]
	path, err := execLookPath(name)
	if err != nil {
		fmt.Printf("  - %-18s MISSING\n", cmd)
		return
	}
	fmt.Printf("  - %-18s OK (%s)\n", cmd, path)
}

func execLookPath(name string) (string, error) {
	return util.LookPath(name)
}

func die(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
