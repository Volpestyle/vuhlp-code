# HTTP API (agentd)

Base URL: `http://127.0.0.1:8787` (configurable)

If `HARNESS_AUTH_TOKEN` is set, all requests require:

```
Authorization: Bearer <token>
```

---

## GET /

Dashboard UI.

---

## POST /v1/runs

Create and start a run.

Request body:
```json
{
  "workspace_path": "/abs/path/to/repo",
  "spec_path": "/abs/path/to/spec.md"
}
```

Response:
```json
{
  "run_id": "run_..."
}
```

---

## GET /v1/runs

List runs (most recent first).

---

## GET /v1/runs/{run_id}

Get run metadata/state.

---

## GET /v1/runs/{run_id}/events

Server-Sent Events (SSE) stream of run events.

Events are sent as JSON lines.

Example:

```
event: message
data: {"ts":"...","type":"log","message":"..."}
```

---

## POST /v1/runs/{run_id}/approve

Approve a gated step.

Request body:
```json
{"step_id":"step_..."}
```

---

## POST /v1/runs/{run_id}/cancel

Cancel a run.

---

## GET /v1/runs/{run_id}/export

Downloads a zip artifact that includes:
- run.json
- events.ndjson
- artifacts/ (if present)

