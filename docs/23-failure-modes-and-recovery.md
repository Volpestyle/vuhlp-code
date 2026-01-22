# Failure modes and recovery

## Status in v0

- Provider spawn errors mark nodes as failed.
- Errors are emitted as `node.progress` / `turn.status` events.
- On daemon start, persisted runs are rehydrated; running runs are set to `paused` and node connections are marked `disconnected`.
- Nodes can be started/stopped/reset via API.

## What exists

- Run pause/resume: PATCH run status via `/api/runs/:runId`
- Node lifecycle: `/api/runs/:runId/nodes/:nodeId/start|stop|reset|interrupt`

## Not implemented in v0

- Automatic retries with backoff
- Structured failure artifacts
- Merge conflict reconciliation
- Loop-stall auto escalation beyond pause
