# Core concepts

## Run
A **Run** is a single orchestration session against a repo/workspace.
Each run has:

- a unique `run_id`
- a `mode`: `AUTO` or `INTERACTIVE`
- a graph: nodes + edges
- an event log (append-only)
- artifacts (diffs, logs, reports)

Run state is stored in `./.vulp/runs/<run_id>/`.

---

## Node
A **Node** is an execution unit with a stable identity and a lifecycle.

Node types (minimum set):

- `orchestrator` — decides what to do next (AUTO mode)
- `agent.codex` — runs Codex CLI turns
- `agent.claude` — runs Claude Code turns
- `agent.gemini` — runs Gemini CLI turns
- `verifier` — runs tests/lint/build checks
- `docs` — updates or reviews docs (optional in barebones)

Node statuses:

- `IDLE` (not started)
- `READY` (can run; waiting for scheduler)
- `RUNNING`
- `BLOCKED` (waiting for approval/manual input/dependency)
- `DONE`
- `ERROR`

Each node has:

- `provider_session` (optional): a provider-native session/thread id
- `tmux_pane` (optional): where the terminal-backed process lives
- `workspace` (optional): path to worktree/dir this node writes to
- `last_output` (structured envelope, see below)

---

## Edge
An **Edge** connects node outputs to downstream inputs.

The **minimum** behavior in v0:

- edges forward the upstream node’s **Final Output Envelope** (a JSON blob)
- downstream nodes decide how to use it

Optional (v1+):

- typed ports (text/report/diff)
- join gates / routers

---

## Output envelope (what flows through edges)
In a barebones system, avoid many payload types. Use one envelope shape:

```json
{
  "kind": "node_result",
  "node_id": "impl-a",
  "turn_id": "turn-003",
  "status": "ok",
  "summary": "Implemented feature X; tests passing",
  "artifacts": [
    {"type": "diff", "path": "artifacts/impl-a/turn-003.patch"},
    {"type": "log",  "path": "logs/impl-a/turn-003.log"}
  ],
  "structured": { "optional": "provider-specific json output" }
}
```

Downstream nodes are responsible for interpreting it.

---

## Session vs Turn
A **Session** is the long-lived provider context (thread/session_id) for a node.
A **Turn** is a single prompt/response exchange:

- In AUTO: orchestrator triggers turns
- In INTERACTIVE: user triggers turns

Even when “turn-based,” session continuity can exist via provider resume flags
or via `vulp`-maintained transcript + context pack.

---

## Terminal-backed session
In this design, each node can have a real terminal surface via **tmux**:

- `vulp` creates tmux panes, runs provider CLIs inside
- user can open/attach to panes in any terminal emulator
- `vulp` can also send input programmatically via `tmux send-keys`

Details in `docs/02-terminal-backed-sessions.md`.

