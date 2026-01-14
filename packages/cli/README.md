# vulp (barebones) — terminal-first multi-agent orchestration

This document set specifies a **minimal, terminal-first** version of *vuhlp code*:
a local CLI tool called **`vulp`** that orchestrates **Codex**, **Claude Code**, and **Gemini CLI**
*while letting you use your own real terminal windows* (Terminal.app, iTerm2, Alacritty, etc.)
instead of a custom GUI.

Key idea:

- `vulp` manages the **graph state** (nodes/edges/status/artifacts) and the **automation loop**
- each agent runs in a **real terminal-backed session** (recommended: **tmux** panes)
- you can **watch** or **take over** any agent from your terminal
- `vulp --viz` deterministically renders the orchestration graph as **ASCII**

This is intentionally **barebones**:
no web UI, no embedded terminal emulator, no complicated event ingestion—just a CLI,
a filesystem-backed run store, and optional JSON event parsing.

---

## What you get

- **Provider-backed nodes**: `codex`, `claude`, `gemini` (and `mock`)
- **Two run modes**:
  - **AUTO**: orchestrator schedules turns automatically
  - **INTERACTIVE**: orchestration pauses; you drive prompts manually
- **Terminal-first UX**:
  - agents run in tmux panes, visible in Terminal/Alacritty
  - optional helper: `vulp open <node>` opens a new window attached to the pane
- **Deterministic graph visualization**:
  - `vulp viz` (or `vulp --viz`) prints an ASCII DAG with statuses
- **Reproducible run store**:
  - `./.vulp/runs/<run_id>/` contains `graph.json`, `events.ndjson`, `artifacts/`, `logs/`

---

## Prerequisites

- macOS or Linux (Windows possible but not documented in v0 docs)
- **tmux** (recommended) for terminal-backed sessions
- Node.js 20+ (recommended implementation language in these docs) or Go/Rust if you prefer
- Installed provider CLIs if you want real agents:
  - `codex` (OpenAI Codex CLI)
  - `claude` (Anthropic Claude Code)
  - `gemini` (Google Gemini CLI)

> If you don't want tmux, you can still run `vulp` in “manual attach” mode:
> you start agent CLIs yourself and only use `vulp` for graph state + viz, but you lose
> reliable automation and log capture.

---

## Quick start workflow (conceptual)

1. `vulp init` in your repo (creates `./.vulp/config.toml`)
2. `vulp run new "My task"` → creates a run directory + tmux session
3. Add nodes:
   - `vulp node add orchestrator`
   - `vulp node add codex --name impl-a`
   - `vulp node add claude --name impl-b`
4. Connect nodes:
   - `vulp edge add orchestrator -> impl-a`
   - `vulp edge add orchestrator -> impl-b`
5. Start auto mode:
   - `vulp run start`
6. Watch:
   - `vulp viz --watch`
   - `vulp open impl-a` (opens a terminal window to that agent pane)

---

## File layout in this zip

- `docs/` — the full product + technical spec for this barebones CLI approach
- `schemas/` — JSON schemas for graph state and events
- `examples/` — sample `graph.json` and `events.ndjson`

Start with: **docs/00-overview.md**.

