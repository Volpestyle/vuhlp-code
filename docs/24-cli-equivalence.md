# CLI Equivalence (Terminal-First Mode)

vuhlp can be used in a UI-first workflow (graph canvas + inspector) or a **terminal-first** workflow where:

- users open real terminal windows (Terminal.app, iTerm2, Alacritty, tmux)
- vuhlp links those sessions “behind the scenes” to graph nodes
- graph state is still persisted and can be visualized deterministically

This document defines the **equivalence contract** between UI and terminal-first usage.

---

## Goals

Terminal-first mode MUST:

- preserve all graph semantics (nodes, edges, turns, payloads)
- keep deterministic replayability via the event log
- allow visualization through `vuhlp --viz` (ASCII) even without the UI
- avoid re-implementing provider harnesses (Codex/Claude/Gemini) beyond launching them and capturing logs

---

## Mapping model

### Node ⇄ Terminal session
A node MAY be backed by a real terminal session.

- Each terminal-backed node has:
  - `nodeId`
  - `provider` (codex/claude/gemini)
  - `terminalSessionRef` (opaque)
  - `providerSessionId` (thread/session id, if available)

The terminal session is the “raw console.”
The graph runtime is the “structured layer.”

### Turns
Even in terminal-first mode, a **turn** is a discrete unit:

- a single provider invocation (start/resume)
- or a single user-entered command sequence that vuhlp brackets as a turn

vuhlp SHOULD support a simple convention:

- `vuhlp turn begin <nodeId>`
- (user interacts normally)
- `vuhlp turn end <nodeId>`

This produces a deterministic turn boundary in the event log.

---

## Dataflow in terminal-first mode

Edges still deliver payload envelopes.

In terminal-first mode, delivery is represented by:

- printing a “handoff banner” into the destination terminal
- writing a payload file into the node’s workspace
- emitting `handoff.sent` + `handoff.delivered` events

The user can then copy/paste or run provider commands as they prefer.

> This model keeps vuhlp lightweight while preserving a faithful graph record.

---

## Deterministic ASCII visualization (`vuhlp --viz`)

The ASCII graph MUST be deterministically renderable from:

- `graph.json` (topology)
- `events.ndjson` (execution history)

Rules:
- nodes are ordered by stable nodeId sort
- edges are ordered by stable edgeId sort
- statuses are derived from the latest node status event

The viz output should include:
- node labels (provider + role)
- node status (queued/running/blocked/completed/failed)
- loop counters when present

---

## What you gain vs UI-first

Terminal-first mode is best when:

- you want perfect CLI fidelity
- you want to use existing terminal muscle memory
- you want minimal UI surface area

UI-first mode is best when:

- you want rich structured inspectors
- you want handoff animations / approvals queue
- you want time-travel debugging

Both modes share the same run store.

---

## Related docs

- `docs/18-execution-semantics.md`
- `docs/03-architecture.md`
