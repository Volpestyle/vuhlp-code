# Suggested Stack (v2)

This is a short recommendation for the optimal stack to build vuhlp from scratch.

## Recommended default
**Daemon:** Node.js 20/22 + TypeScript
- Best fit for CLI process spawning and streaming output parsing.
- Fast iteration for runtime + provider adapters.

**Transport:** REST + WebSocket
- Simple, stable contract for UI and future iOS client.

**State:** SQLite + filesystem
- SQLite for runs, events, indexes.
- Filesystem for artifacts (diffs, logs, prompts, transcripts).

**UI:** React + Vite
- Mature graph ecosystem and fast iteration.
- Canvas-based graph rendering (Cytoscape or custom).

**Schemas:** JSON Schema + TypeScript types
- Keep the contract authoritative and portable.

## Alternatives (supported if tested)
- **Bun runtime:** Faster startup, but verify CLI streaming, signals, and stdio stability.
- **Go daemon:** Strong reliability and single-binary distribution; slower iteration than TS.

## Why this is optimal
- The product is I/O bound, not CPU bound.
- CLI session continuity and streaming are the hardest parts; Node is proven here.
- A stable WS/REST contract allows future SwiftUI iOS control without backend changes.
