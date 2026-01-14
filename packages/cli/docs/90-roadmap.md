# Roadmap (after barebones v0)

This spec is intentionally minimal.

High-value v1/v2 improvements:

## v1: reliability & ergonomics
- worktree isolation for parallel write nodes
- join gates (fan-in) and routers (conditional edges)
- robust structured parsing (Codex JSONL / Claude stream-json / Gemini json)
- export/import run zip
- a minimal TUI (optional) for interactive exploration

## v2: autonomy upgrades
- real LLM orchestrator with structured action outputs
- docs-first “Plan vs Implement” gating
- stall detection and loop termination heuristics

## v3: power-user workflows
- templates (“Fix failing tests”, “Generate docs”, “Build feature”)
- plugin adapters
- remote runners / shared runs

