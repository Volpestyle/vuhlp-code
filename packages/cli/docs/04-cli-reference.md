# CLI reference (spec)

This is the proposed `vulp` CLI surface for the barebones product.

> Names are illustrative; keep the command set small and composable.

---

## Global flags
- `--run <run_id>`: select run (default: most recent)
- `--repo <path>`: repo root (default: cwd)
- `--json`: output machine-readable JSON instead of human text
- `--verbose`: more logs

---

## Core commands

### `vulp init`
Creates `.vulp/config.toml` with defaults.

### `vulp run new "<prompt>"`
Creates a new run directory and prints the run_id.

Options:
- `--mode auto|interactive` (default: interactive)
- `--tmux/--no-tmux` (default: tmux if available)

### `vulp run start`
Starts the run loop in background *for this shell invocation* (no daemon required):
- in AUTO: ticks until done or stopped
- in INTERACTIVE: does nothing unless user triggers turns

### `vulp run mode auto|interactive`
Switch run mode.

### `vulp run status`
Prints run status summary.

---

## Graph editing

### `vulp node add <type>`
Types:
- `orchestrator`
- `codex`
- `claude`
- `gemini`
- `verifier`
- `docs` (optional)

Options:
- `--name <name>`
- `--workspace <path|worktree>`
- `--control auto|manual` (node-level override)

### `vulp edge add <from> -> <to>`
Connect nodes.
Options:
- `--selector summary|structured|artifacts|all` (default all)
- `--mode latest|queue` (default latest)

### `vulp node rm <node_id>`
Remove node (requires no running turn).

---

## Running turns

### `vulp turn send <node_id> "<message>"`
Sends a prompt to a node and executes exactly one turn.

Options:
- `--schema <path>`: expected JSON schema output
- `--context <file>`: attach a context pack JSON
- `--allow-tools <list>`: adapter-specific tool allow-list

### `vulp turn continue <node_id>`
Runs a “continue” turn with a default message:
“Continue from the current state; follow docs; produce output envelope.”

### `vulp verify`
Runs verifier node(s) (tests/lint) and stores results as artifacts.

---

## Terminal helpers

### `vulp open <node_id>`
Opens a new terminal window attached to the run’s tmux session (or directly to a pane).

Options:
- `--terminal terminal|alacritty|iterm` (best-effort)

### `vulp tmux ls`
Shows tmux panes/windows associated with the run.

---

## Visualization

### `vulp viz`
Print ASCII graph with statuses.

Options:
- `--watch` refresh every N seconds
- `--layout dag|layered|compact`
- `--show-edges` include edge labels
- `--show-artifacts` show last artifacts counts

---

## Export / import

### `vulp export <run_id>`
Zips `.vulp/runs/<run_id>`.

### `vulp import <path.zip>`
Imports a run directory for viewing/viz.

