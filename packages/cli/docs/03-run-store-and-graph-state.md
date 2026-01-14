# Run store and deterministic graph state

## Goals
- A run should be reproducible and portable as a directory.
- `vulp viz` should be deterministic from stored files.
- Concurrency must not corrupt state (multiple CLI commands at once).

---

## Recommended run directory layout

In repo root:

```
.vulp/
  config.toml
  runs/
    <run_id>/
      run.json
      graph.json
      events.ndjson
      sessions.json
      logs/
        <node_id>/
          pane.log
          turn-001.log
      artifacts/
        <node_id>/
          turn-001.patch
          turn-001.events.ndjson
```

### run.json
Run metadata: prompt, created_at, mode, budgets.

### graph.json
The authoritative graph state:
- nodes, edges, statuses, workspace refs
- last outputs (envelopes)
- node configs

### events.ndjson
Append-only canonical events emitted by `vulp`.
This is the source-of-truth for auditability.
`graph.json` can be derived from events (event-sourcing) but in v0 you can store both.

### sessions.json
Provider session IDs and tmux pane IDs per node.

---

## Concurrency strategy (barebones)
Use a simple file lock:

- `flock .vulp/runs/<run_id>/.lock` for any mutation of graph or events

If implementing in Node, use:
- `proper-lockfile` or an OS-level `flock` wrapper

If implementing in Go/Rust:
- use `flock(2)` directly.

---

## Deterministic IDs
To make ASCII graphs stable, generate deterministic IDs:

- `run_id`: timestamp + short hash of repo path
- `node_id`: slug + increment (impl-a, impl-b) or UUID but stable within run
- `turn_id`: sequential `turn-001`, `turn-002`, …

---

## Canonical events (minimal set)

Each line in `events.ndjson` is JSON with:

- `ts`: ISO timestamp
- `type`: event type string
- `run_id`
- `node_id` (optional)
- `data`: event payload

Minimum types:

- `run.created`
- `run.mode_changed`
- `node.added`
- `node.status`
- `edge.added`
- `turn.started`
- `turn.completed`
- `artifact.written`
- `log.mark`

See `schemas/events.schema.json`.

---

## Graph snapshot strategy
For v0:

- update `graph.json` after any event batch
- use `events.ndjson` as the audit trail

For v1:

- derive graph from events only
- snapshots are caches.

