# HTTP + WebSocket API

Base URL: `http://localhost:<port>`

## REST

### GET /health

Returns basic status.

### GET /api/runs

List runs.

### POST /api/runs

Create a run.

Body:

```json
{
  "prompt": "Build feature X...",
  "repoPath": "/path/to/repo",
  "configOverrides": {}
}
```

### GET /api/runs/:runId

Returns run state snapshot.

### POST /api/runs/:runId/stop

Stops a run (best-effort abort).

### GET /api/runs/:runId/artifacts/:artifactId

Returns artifact metadata and provides a download URL.

## WebSocket

Endpoint: `ws://localhost:<port>/ws`

Client → server:

- `{"type":"subscribe","runId":"..."}`
- `{"type":"snapshot","runId":"..."}`

Server → client:

- `{"type":"snapshot","run":{...}}`
- `{"type":"event","event":{...}}`
- `{"type":"error","message":"..."}`
