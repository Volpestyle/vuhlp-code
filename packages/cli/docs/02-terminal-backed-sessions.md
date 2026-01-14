# Terminal-backed sessions (tmux-first)

## Why tmux?
tmux gives you:

- a stable PTY for each node
- the ability to **attach** from any terminal emulator
- programmatic control (`tmux send-keys`, `tmux capture-pane`, `tmux pipe-pane`)
- a simple concurrency story (many panes in one session)

This matches your requirement: “user opens actual terminal or alacritty windows on their device”
while `vulp` links instances behind the scenes.

---

## Core tmux model

For each Run:

- create a tmux session: `vulp:<run_id>`
- create a tmux window per node, or one window with one pane per node
- each node stores: `tmux_session`, `tmux_window`, `tmux_pane_id`

Recommended:

- One window per node (simplest to address and attach)
- Pane title includes node name + status

Example tmux identifiers:

- session: `vulp:run_2026-01-13T12-00-00Z`
- window: `impl-a`
- pane id: `%12`

---

## Starting a node process

Two ways:

### A) “Managed turn runner” (recommended)
Each time you trigger a turn, you run a one-shot command in the pane:

- Codex: `codex exec ...` (possibly `--json`)
- Claude: `claude -p ...`
- Gemini: `gemini -p ...`

The turn command is executed, output logged, process exits.
Session continuity is implemented by provider resume flags and/or transcript injection.

Pros:
- deterministic
- easy to capture logs per turn
- easy to retry

Cons:
- not a single continuous REPL process

### B) “Continuous REPL” (optional)
Start `codex` / `claude` / `gemini` in interactive REPL mode and keep it running.
Then both the user and `vulp` can send keystrokes.

Pros:
- true interactive feel
- easy for user takeover

Cons:
- harder to parse
- harder to make deterministic
- relies on each tool’s interactive UX stability

For v0 barebones, implement (A) first.

---

## Log capture and artifacts

### Raw logs
Use `tmux pipe-pane` to write pane output to a file:

- `logs/<node_id>/pane.log` (append-only)

For per-turn logs, use separators:

- before running a turn, `vulp` prints a marker line:
  `=== VULP TURN turn-003 START ===`
- after completion:
  `=== VULP TURN turn-003 END status=ok ===`

This allows deterministic slicing of logs later.

### Structured output capture (optional)
If you run harnesses with JSON output:
- write raw NDJSON to `artifacts/<node_id>/turn-003.events.ndjson`
- simultaneously pretty-print to terminal (optional)

Even if you don't parse it, storing it is valuable.

---

## Opening real terminal windows

### macOS Terminal.app
Open a new window attached to a pane:

- simplest: open a window attached to the tmux session:
  `open -na Terminal --args -c "tmux attach -t vulp:<run_id>"`

Selecting a specific window inside tmux can be done with:
- `tmux select-window -t vulp:<run_id>:impl-a`

### Alacritty
Alacritty can run a command via `-e`:

- `alacritty -e tmux attach -t vulp:<run_id>`

(You can also open a window focused on a window name:
`alacritty -e tmux attach -t vulp:<run_id> \; select-window -t impl-a`)

### Manual attach (user-driven)
Users can always:
- open any terminal
- run: `tmux attach -t vulp:<run_id>`

---

## Sending input programmatically
In AUTO mode, `vulp` needs to send prompts and run commands.

Use:

- `tmux send-keys -t <pane_id> "..." Enter`

For managed turns (recommended), `vulp` writes a full command line into the pane
and presses Enter.

---

## Capturing pane contents for state sync (optional)
If you want to “peek” at what happened without parsing logs:

- `tmux capture-pane -p -t <pane_id> -S -2000` (last 2000 lines)

This can be used to recover if log piping fails.

