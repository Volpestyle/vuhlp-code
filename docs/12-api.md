# HTTP + WebSocket API

Base URL: `http://localhost:<port>` (default `4000`).

## Filesystem

### GET /api/fs/list

Query:
- `path` (optional)

Returns directory entries rooted at the repo.

---

## Runs

### GET /api/runs

Returns all runs.

### POST /api/runs

Body:

```json
{
  "mode": "AUTO",
  "globalMode": "PLANNING",
  "cwd": "/path/to/repo"
}
```

### GET /api/runs/:runId

Returns run snapshot.

### PATCH /api/runs/:runId

Patch run fields:

```json
{ "patch": { "status": "paused" } }
```

### DELETE /api/runs/:runId

Deletes a run and its data.

### GET /api/runs/:runId/events

Returns stored event log.

---

## Nodes

### POST /api/runs/:runId/nodes

```json
{
  "node": {
    "label": "Implementer",
    "provider": "claude",
    "roleTemplate": "implementer",
    "capabilities": { "edgeManagement": "none" },
    "permissions": { "cliPermissionsMode": "skip" }
  }
}
```

### PATCH /api/runs/:runId/nodes/:nodeId

```json
{ "patch": { "summary": "idle" }, "config": { "session": { "resume": true } } }
```

### DELETE /api/runs/:runId/nodes/:nodeId

### POST /api/runs/:runId/nodes/:nodeId/reset

### POST /api/runs/:runId/nodes/:nodeId/start

### POST /api/runs/:runId/nodes/:nodeId/stop

### POST /api/runs/:runId/nodes/:nodeId/interrupt

---

## Edges

### POST /api/runs/:runId/edges

```json
{ "edge": { "from": "node-a", "to": "node-b", "type": "handoff", "bidirectional": true } }
```

### DELETE /api/runs/:runId/edges/:edgeId

---

## Chat

### POST /api/runs/:runId/chat

```json
{ "nodeId": "node-id", "content": "Message", "interrupt": false }
```

---

## Artifacts

### GET /api/runs/:runId/artifacts/:artifactId

Returns:

```json
{ "artifact": { "id": "..." }, "content": "..." }
```

---

## Templates

### GET /api/templates

### GET /api/templates/:name

### POST /api/templates

```json
{ "name": "implementer", "content": "..." }
```

### PUT /api/templates/:name

```json
{ "content": "..." }
```

### DELETE /api/templates/:name

---

## Approvals

### GET /api/approvals

### POST /api/approvals/:id/resolve

```json
{ "resolution": { "status": "approved" }, "runId": "optional" }
```

---

## WebSocket

Endpoint: `ws://localhost:<port>/ws`

Optional filter:
- `?runId=<runId>`

Events are JSON objects matching the event contract.
