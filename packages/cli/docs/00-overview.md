# Overview

This doc set specifies **vulp**, a **terminal-first orchestration CLI**.

Unlike the full GUI product, **vulp intentionally does not embed** terminals or build a web UI.
Instead, `vulp`:

1. maintains a deterministic **graph state** (nodes/edges/status)
2. starts agent processes in **tmux panes** (recommended)
3. optionally parses structured outputs (JSONL/NDJSON) when harnesses support it
4. writes all state to a local run directory
5. can render the graph and status as **ASCII** (`vulp viz`)

You still get the key capabilities:

- multiple agents (Codex/Claude/Gemini) operating concurrently
- an orchestrator that can run in **AUTO** mode (hands off tasks, collects results, verifies, loops)
- a user-driven **INTERACTIVE** mode where automation pauses and you drive prompts manually
- a deterministic audit trail of what happened (events + artifacts)

---

## Product goals for this “barebones” build

**G1 — Keep the user in real terminals**
- You should be able to watch agent output in Terminal.app or Alacritty.
- You should be able to type directly into the agent session when you want.

**G2 — Keep orchestration deterministic and debuggable**
- Graph visualization is deterministic from stored state.
- Run store is self-contained and portable.
- CLI output is concise; details are in logs/artifacts.

**G3 — Reuse default harnesses**
- Codex CLI, Claude Code CLI, Gemini CLI remain the primary execution engines.
- `vulp` is an orchestration harness + state manager, not a replacement agent.

**G4 — Autonomy is optional**
- You can drive everything manually in INTERACTIVE mode.
- AUTO mode uses an orchestrator agent (LLM or rules) to schedule turns.

---

## Non-goals (v0 docs)

- Building a cross-platform terminal emulator
- Perfect structured parsing for every provider output
- Full “graph workflow marketplace” template system
- Remote multi-machine orchestration

Those can come later; see `docs/90-roadmap.md`.

