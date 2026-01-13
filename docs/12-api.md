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
  "mode": "AUTO",
  "policy": {
    "autoPauseOn": {
      "onApprovalRequested": true,
      "onVerificationFailed": false
    }
  }
}
```

- `mode` (optional): Run mode - `"AUTO"` (default) or `"INTERACTIVE"`
- `policy` (optional): Run-level policy configuration

### GET /api/runs/:runId

Returns run state snapshot.

### POST /api/runs/:runId/stop

Stops a run (best-effort abort).

### DELETE /api/runs/:runId

Delete a single run. Stops the run first if active, then removes all data from disk.

Response:

```json
{
  "ok": true,
  "runId": "run-uuid"
}
```

### DELETE /api/runs

Delete multiple runs or clear all runs.

Body (optional):

```json
{
  "runIds": ["run-uuid-1", "run-uuid-2"]
}
```

- If `runIds` is provided, deletes only those runs
- If no body, deletes ALL runs

Response:

```json
{
  "ok": true,
  "deleted": 5
}
```

### GET /api/runs/:runId/artifacts/:artifactId

Returns artifact metadata and provides a download URL.

### POST /api/runs/:runId/pause

Pauses a running run (blocks all node executions).

### POST /api/runs/:runId/resume

Resumes a paused run.

Body (optional):

```json
{
  "feedback": "Optional correction or guidance"
}
```

## Run Mode API

Control the orchestration mode (AUTO/INTERACTIVE).

### GET /api/runs/:runId/run-mode

Get the current run mode.

Response:

```json
{
  "mode": "AUTO"
}
```

### POST /api/runs/:runId/run-mode

Set the run mode.

Body:

```json
{
  "mode": "INTERACTIVE"
}
```

- When switching to `INTERACTIVE`: Stops new turn scheduling (running turns complete)
- When switching to `AUTO`: Resumes automatic scheduling

Response:

```json
{
  "ok": true,
  "mode": "INTERACTIVE"
}
```

## Node Control API

Control individual node scheduling.

### GET /api/runs/:runId/nodes/:nodeId/control

Get the node control setting.

Response:

```json
{
  "control": "AUTO"
}
```

### POST /api/runs/:runId/nodes/:nodeId/control

Set the node control.

Body:

```json
{
  "control": "MANUAL"
}
```

- `AUTO`: Node follows run-level mode (default)
- `MANUAL`: Node always requires manual triggering

## Manual Turn API

Drive agent turns manually (for INTERACTIVE mode or MANUAL nodes).

### POST /api/runs/:runId/nodes/:nodeId/turn

Send a manual turn to a node.

Body:

```json
{
  "message": "Implement the login form with validation",
  "options": {
    "attachContext": ["Previous discussion about auth requirements"],
    "expectedSchema": "{\"type\":\"object\",\"properties\":{...}}"
  }
}
```

Response:

```json
{
  "success": true,
  "output": { ... }
}
```

### POST /api/runs/:runId/nodes/:nodeId/continue

Send a "continue" instruction to resume a paused agent.

Response:

```json
{
  "success": true,
  "output": { ... }
}
```

### POST /api/runs/:runId/nodes/:nodeId/cancel

Cancel/skip a node.

Response:

```json
{
  "ok": true
}
```

### POST /api/runs/:runId/verify

Manually run verification.

Body (optional):

```json
{
  "profileId": "custom-profile"
}
```

Response:

```json
{
  "success": true,
  "ok": true
}
```

### POST /api/runs/:runId/nodes

Create a new node manually.

Body:

```json
{
  "parentNodeId": "optional-parent-node-id",
  "providerId": "claude",
  "role": "implementer",
  "label": "Manual Task",
  "control": "MANUAL"
}
```

Response:

```json
{
  "node": { ... }
}
```

## Approval API

### GET /api/approvals

List all pending approvals across all runs.

Response:

```json
{
  "approvals": [
    {
      "id": "approval-uuid",
      "runId": "run-uuid",
      "nodeId": "node-uuid",
      "tool": {
        "id": "tool-uuid",
        "name": "Bash",
        "args": { "command": "rm -rf /tmp/cache" },
        "riskLevel": "high"
      },
      "status": "pending",
      "createdAt": "2024-01-01T00:00:00Z",
      "timeoutAt": "2024-01-01T00:01:00Z"
    }
  ]
}
```

### POST /api/approvals/:id

Resolve an approval request.

Body:

```json
{
  "action": "approve" | "deny" | "modify",
  "feedback": "Optional feedback",
  "modifiedArgs": { "command": "ls -la" }
}
```

Response:

```json
{
  "success": true,
  "resolution": {
    "status": "approved",
    "feedback": "..."
  }
}
```

## WebSocket

Endpoint: `ws://localhost:<port>/ws`

Client → server:

- `{"type":"subscribe","runId":"..."}`
- `{"type":"snapshot","runId":"..."}`

Server → client:

- `{"type":"snapshot","run":{...}}`
- `{"type":"event","event":{...}}`
- `{"type":"error","message":"..."}`
