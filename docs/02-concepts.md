# Concepts

## Run

A **Run** is a single orchestration attempt from an input prompt/spec through completion.

A run has:

- id
- prompt
- configuration snapshot
- nodes, edges, artifacts
- iteration count
- status: `queued | running | completed | failed | stopped`

## Node

A **Node** is a unit of work visualized in the graph.

Node types in v0:

- `orchestrator` — the controller (root brain) for a run
- `task` — a worker execution (Codex/Claude/Gemini/Mock)
- `verification` — deterministic checks (tests/lint/build/etc.)
- `merge` — (reserved) consolidation/conflict-resolution step

Node status:

- `queued | running | completed | failed | skipped`

## Edge

An **Edge** represents a relationship:

- `handoff` — orchestrator → task
- `dependency` — task A must finish before task B
- `report` — task → orchestrator
- `gate` — verification gating further work

## Artifact

An **Artifact** is any persistent output attached to a node:

- logs (`stdout`, `stderr`)
- JSON outputs (plan, review report)
- diffs / patches
- verification reports

Artifacts are stored on disk under:

- `.vuhlp/runs/<runId>/artifacts/...`

and referenced in run state as metadata.

## Provider

A **Provider** is a worker agent implementation. In v0:

- `mock` — built-in fake agent for testing
- `codex-cli` — spawns `codex` CLI and parses JSONL output best-effort
- `claude-cli` — spawns `claude` CLI and parses JSON stream best-effort
- `gemini-cli` — spawns `gemini` CLI and parses JSON output best-effort
