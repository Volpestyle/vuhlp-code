# Design decisions (v0)

## Why local-first?

- Mirrors how Codex/Claude/Gemini CLIs are commonly used
- Keeps auth simple (reuse existing login flows)
- Avoids storing credentials in vuhlp code

## Why canonical events?

Provider harnesses vary. A stable event model enables:
- consistent UI
- deterministic storage
- provider-independent replay/export

## Why Cytoscape?

- Mature graph UI tooling
- Fast enough for current graph sizes
- Easy to integrate with React

## Why JSONL event logs?

- Append-only
- Human debuggable
- Easy to stream
- Fits event-sourced state materialization

## Why not store chain-of-thought?

- Providers differ in what they expose
- v0 focuses on observable actions, tool calls, and outputs
- Optional thinking streams are supported when providers emit them
