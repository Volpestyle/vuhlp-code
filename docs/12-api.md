# HTTP + WebSocket API

Base URL: `http://localhost:<port>`

## REST

### GET /health

Returns basic status.

Response:

```json
{
  "ok": true,
  "now": "2024-01-01T00:00:00Z",
  "dataDir": ".vuhlp"
}
```

### GET /api/config

Get current configuration.

Response:

```json
{
  "config": { ... }
}
```

### POST /api/config

Update configuration. Changes are persisted to disk.

> **Note:** Some changes require daemon restart to take effect.

Body:

```json
{
  "server": { "port": 4317 },
  "providers": { ... },
  "roles": { ... }
}
```

Response:

```json
{
  "ok": true,
  "config": { ... }
}
```

### GET /api/providers

List all configured providers with health status.

Response:

```json
{
  "providers": [
    {
      "id": "claude",
      "displayName": "Claude Code (CLI)",
      "kind": "claude-cli",
      "capabilities": {
        "streaming": true,
        "structuredOutput": true,
        "resumableSessions": true
      },
      "health": { "ok": true, "message": "claude 1.0.0" }
    }
  ]
}
```

---

## Run Management

### GET /api/runs

List runs.

Query params:
- `includeArchived=true` - Include archived runs

Response:

```json
{
  "runs": [
    {
      "id": "run-uuid",
      "name": "My Task",
      "prompt": "...",
      "status": "running",
      "mode": "AUTO",
      "workflowMode": "implementation",
      "createdAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

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

Response:

```json
{
  "runId": "run-uuid",
  "run": { ... }
}
```

### GET /api/runs/:runId

Returns run state snapshot.

### PATCH /api/runs/:runId

Rename a run.

Body:

```json
{
  "name": "New Run Name"
}
```

Response:

```json
{
  "ok": true,
  "run": { ... }
}
```

### POST /api/runs/:runId/stop

Stops a run (best-effort abort).

### POST /api/runs/:runId/archive

Archive a run (soft-delete). Stops the run first if active.

Response:

```json
{
  "ok": true,
  "run": { ... }
}
```

### POST /api/runs/:runId/unarchive

Restore an archived run.

Response:

```json
{
  "ok": true,
  "run": { ... }
}
```

### DELETE /api/runs/:runId

Delete a single run permanently. Stops the run first if active, then removes all data from disk.

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

---

## Artifacts

### GET /api/runs/:runId/artifacts/:artifactId/download

Download an artifact file.

Response: File stream with appropriate Content-Type and Content-Disposition headers.

---

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

---

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

---

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

---

## Graph Editing API

Manually create nodes and edges in the run graph.

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

- `providerId` (required): Provider to use for this node
- `parentNodeId` (optional): Parent node ID, defaults to root orchestrator
- `role` (optional): Role hint (investigator, planner, implementer, reviewer)
- `label` (optional): Display label for the node
- `control` (optional): AUTO or MANUAL

Response:

```json
{
  "node": { ... }
}
```

### POST /api/runs/:runId/edges

Create a new edge manually.

Body:

```json
{
  "sourceId": "node-uuid-1",
  "targetId": "node-uuid-2",
  "type": "handoff",
  "label": "Optional label"
}
```

- `sourceId` (required): Source node ID
- `targetId` (required): Target node ID
- `type` (optional): Edge type - `handoff` (default), `dependency`, `report`
- `label` (optional): Display label

Response:

```json
{
  "ok": true
}
```

---

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

### GET /api/approvals/all

List all approvals (including resolved).

### GET /api/approvals/:approvalId

Get a specific approval by ID.

Response:

```json
{
  "approval": { ... }
}
```

### POST /api/approvals/:approvalId/approve

Approve a pending request.

Body (optional):

```json
{
  "feedback": "Optional feedback"
}
```

### POST /api/approvals/:approvalId/deny

Deny a pending request.

Body (optional):

```json
{
  "feedback": "Reason for denial"
}
```

### POST /api/approvals/:approvalId/modify

Approve with modified arguments.

Body:

```json
{
  "modifiedArgs": { "command": "ls -la" },
  "feedback": "Modified for safety"
}
```

### POST /api/approvals/:approvalId/resolve

Generic resolution endpoint (alternative to approve/deny/modify).

Body:

```json
{
  "status": "approved",
  "feedback": "Optional feedback",
  "modifiedArgs": { ... }
}
```

- `status` (required): `approved`, `denied`, or `modified`

---

## Session API

Provider session continuity.

### GET /api/sessions

List sessions for a run.

Query params:
- `runId` (optional): Filter by run ID

Response:

```json
{
  "sessions": [
    {
      "nodeId": "node-uuid",
      "runId": "run-uuid",
      "providerId": "claude",
      "providerSessionId": "session-uuid",
      "createdAt": "2024-01-01T00:00:00Z",
      "lastUsedAt": "2024-01-01T00:01:00Z"
    }
  ]
}
```

### GET /api/sessions/:nodeId

Get session for a specific node.

---

## Chat API

Send messages to runs or nodes.

### POST /api/runs/:runId/chat

Send a chat message to a run.

Body:

```json
{
  "content": "Please also add unit tests",
  "nodeId": "optional-target-node",
  "interrupt": true
}
```

- `content` (required): Message content
- `nodeId` (optional): Target specific node
- `interrupt` (optional, default true): Interrupt current execution

### POST /api/runs/:runId/nodes/:nodeId/chat

Send a chat message to a specific node.

Body:

```json
{
  "content": "Focus on the login component first",
  "interrupt": true
}
```

### GET /api/runs/:runId/chat

Get chat messages for a run.

Query params:
- `nodeId` (optional): Filter by node

Response:

```json
{
  "messages": [
    {
      "id": "msg-uuid",
      "runId": "run-uuid",
      "nodeId": "node-uuid",
      "role": "user",
      "content": "...",
      "createdAt": "2024-01-01T00:00:00Z",
      "processed": true,
      "interruptedExecution": false
    }
  ]
}
```

---

## Interaction Mode API

Control chat interaction mode (autonomous/interactive).

### GET /api/runs/:runId/mode

Get interaction mode.

Query params:
- `nodeId` (optional): Get mode for specific node

Response:

```json
{
  "mode": "autonomous"
}
```

### POST /api/runs/:runId/mode

Set interaction mode.

Body:

```json
{
  "mode": "interactive",
  "nodeId": "optional-node-id"
}
```

- `mode`: `autonomous` or `interactive`

---

## Prompt Queue API

Manage pending prompts (orchestrator-generated and user-written).

### GET /api/runs/:runId/prompts

Get pending prompts for a run.

Response:

```json
{
  "prompts": [ ... ],
  "orchestratorPending": [ ... ],
  "userPending": [ ... ],
  "hasOrchestratorPending": true
}
```

### GET /api/runs/:runId/prompts/:promptId

Get a specific prompt.

### POST /api/runs/:runId/prompts

Add a user prompt to the queue.

Body:

```json
{
  "content": "Also check for edge cases",
  "targetNodeId": "optional-node-uuid"
}
```

Response:

```json
{
  "prompt": {
    "id": "prompt-uuid",
    "runId": "run-uuid",
    "source": "user",
    "content": "...",
    "status": "pending",
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

### POST /api/runs/:runId/prompts/:promptId/send

Send a pending prompt to its target node.

### POST /api/runs/:runId/prompts/:promptId/cancel

Cancel a pending prompt.

Body (optional):

```json
{
  "reason": "No longer needed"
}
```

### PATCH /api/runs/:runId/prompts/:promptId

Modify a pending prompt's content.

Body:

```json
{
  "content": "Updated prompt content"
}
```

---

## File System API

Browse and read files from the system.

### GET /api/system/fs

Browse directories.

Query params:
- `path` (optional): Directory path, defaults to current working directory
- `includeFiles=true` (optional): Include files, not just directories

Response:

```json
{
  "path": "/Users/name/project",
  "parent": "/Users/name",
  "entries": [
    { "name": "src", "path": "/Users/name/project/src", "isDirectory": true },
    { "name": "package.json", "path": "/Users/name/project/package.json", "isDirectory": false }
  ]
}
```

### GET /api/system/fs/read

Read a text file.

Query params:
- `path` (required): File path

Limitations:
- Max file size: 1MB
- Binary files not supported

Response:

```json
{
  "path": "/Users/name/project/src/index.ts",
  "content": "...",
  "size": 1234
}
```

---

## WebSocket

Endpoint: `ws://localhost:<port>/ws`

### Client to Server Messages

**Subscribe to events:**

```json
{"type": "subscribe", "runId": "run-uuid"}
```

Or subscribe to all runs:

```json
{"type": "subscribe", "runId": "*"}
```

**Request snapshot:**

```json
{"type": "snapshot", "runId": "run-uuid"}
```

### Server to Client Messages

**Hello (on connection):**

```json
{
  "type": "hello",
  "now": "2024-01-01T00:00:00Z",
  "runs": [
    { "id": "run-uuid", "status": "running", "createdAt": "...", "prompt": "..." }
  ]
}
```

**Subscription confirmed:**

```json
{"type": "subscribed", "runIds": ["run-uuid"]}
```

**Run snapshot:**

```json
{"type": "snapshot", "run": { ... }}
```

**Event stream:**

```json
{"type": "event", "event": { ... }}
```

**Error:**

```json
{"type": "error", "message": "..."}
```

### Event Types

Events streamed via WebSocket include:

**Run lifecycle:**
- `run.created`, `run.started`, `run.updated`, `run.completed`, `run.failed`, `run.stopped`, `run.paused`, `run.resumed`
- `run.mode.changed` (AUTO/INTERACTIVE toggle)
- `run.workflow_mode.changed` (Planning/Implementation toggle)

**Node lifecycle:**
- `node.created`, `node.started`, `node.progress`, `node.completed`, `node.failed`
- `node.control.changed` (AUTO/MANUAL toggle)
- `turn.started`, `turn.completed` (manual turns)

**Messages:**
- `message.user`, `message.assistant.delta`, `message.assistant.final`, `message.reasoning`

**Tools:**
- `tool.proposed`, `tool.started`, `tool.completed`

**Console:**
- `console.chunk` (raw stdout/stderr)

**Approvals:**
- `approval.requested`, `approval.resolved`

**Handoffs:**
- `handoff.sent`, `handoff.reported`

**Chat:**
- `chat.message.sent`, `chat.message.queued`, `interaction.mode.changed`

**Prompts:**
- `prompt.queued`, `prompt.sent`, `prompt.cancelled`

**Graph:**
- `edge.created`, `artifact.created`, `verification.completed`
