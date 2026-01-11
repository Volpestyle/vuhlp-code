# Design decisions (v0)

## Why local-first?

- Mirrors how Codex/Claude Code/Gemini CLI are commonly used
- Keeps auth simple (reuse existing login flows)
- Avoids storing credentials in vuhlp code

## Why canonical events?

Provider harnesses vary.
A stable event model enables:

- a consistent UI
- deterministic storage
- provider-independent replay/export

## Why Cytoscape?

- Good ergonomics for graph UIs
- Works without a heavy frontend toolchain
- Fast enough for MVP-sized graphs

## Why JSONL event log?

- Append-only
- Human debuggable
- Easy to stream
- Good fit for event-sourced state materialization

## Why “thought summaries” instead of raw chain-of-thought?

Providers differ, and raw CoT is not always available or safe to expose.
v0 prioritizes:

- observable actions
- structured outputs
- explicit reasoning summaries when provided
