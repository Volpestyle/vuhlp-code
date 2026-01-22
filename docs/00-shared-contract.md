# Shared Contract (Build Alignment)

Use this as the single source of truth for runtime ↔ provider ↔ UI integration.

## Versioning
- `contractVersion = "1"` (required in run state).
- Breaking changes require a new version and a migration note.

## Identifiers & time
- `runId`, `nodeId`, `edgeId`, `payloadId`, `artifactId`: UUID strings.
- All timestamps are ISO-8601 UTC.

## Event envelope (shared)
Every event must include these fields:

```json
{
  "id": "event-uuid",
  "runId": "run-uuid",
  "ts": "2026-01-01T00:00:00Z",
  "type": "event.type",
  "nodeId": "optional-node-uuid"
}
```

Event logs are append-only JSONL files at `dataDir/runs/<runId>/events.jsonl`.

## Run state (minimum fields)

```json
{
  "id": "run-uuid",
  "contractVersion": "1",
  "status": "queued | running | paused | stopped | completed | failed",
  "mode": "AUTO | INTERACTIVE",
  "globalMode": "PLANNING | IMPLEMENTATION",
  "createdAt": "2026-01-01T00:00:00Z",
  "updatedAt": "2026-01-01T00:00:00Z",
  "nodes": { "nodeId": { "...": "..." } },
  "nodeConfigs": { "nodeId": { "...": "..." } },
  "edges": { "edgeId": { "...": "..." } },
  "artifacts": { "artifactId": { "...": "..." } }
}
```

Run snapshots are stored at `dataDir/runs/<runId>/state.json`.

## Node state

```json
{
  "id": "node-uuid",
  "runId": "run-uuid",
  "label": "Implementer A",
  "roleTemplate": "implementer",
  "provider": "codex | claude | gemini | custom",
  "status": "idle | running | blocked | failed",
  "summary": "short live status",
  "lastActivityAt": "2026-01-01T00:00:00Z",
  "capabilities": {
    "edgeManagement": "none",
    "writeCode": true,
    "writeDocs": true,
    "runCommands": true,
    "delegateOnly": false
  },
  "permissions": {
    "cliPermissionsMode": "skip | gated",
    "agentManagementRequiresApproval": true
  },
  "session": {
    "sessionId": "provider-session-id",
    "resetCommands": ["/new", "/clear"]
  }
}
```

## Edge state

```json
{
  "id": "edge-uuid",
  "from": "node-a",
  "to": "node-b",
  "bidirectional": true,
  "type": "handoff | report",
  "label": "task | report | custom"
}
```

Defaults:
- Orchestrator -> node: `type = handoff`, `label = "task"`.
- Node -> orchestrator: `type = report`, `label = "report"`.

## Envelope (handoff payload)

```json
{
  "kind": "handoff",
  "id": "payload-uuid",
  "fromNodeId": "node-a",
  "toNodeId": "node-b",
  "createdAt": "2026-01-01T00:00:00Z",
  "payload": {
    "message": "short summary",
    "structured": { "key": "value" },
    "artifacts": [
      { "type": "diff", "ref": "artifact://diff/123" }
    ],
    "status": { "ok": true, "reason": "tests-pass" },
    "response": { "expectation": "optional", "replyTo": "node-a" }
  }
}
```

## Artifacts

```json
{
  "id": "artifact-uuid",
  "runId": "run-uuid",
  "nodeId": "node-uuid",
  "kind": "diff | prompt | log | transcript | contextpack | report",
  "name": "diff.patch",
  "path": "/abs/path/to/file",
  "createdAt": "2026-01-01T00:00:00Z"
}
```

Prompt artifacts are required per turn:
- `prompt.full.txt`
- `prompt.blocks.json`

Diff artifacts are emitted when available.

## Tool event payloads (minimum)

```json
{
  "type": "tool.proposed",
  "nodeId": "node-uuid",
  "tool": { "id": "tool-uuid", "name": "command", "args": { "cmd": "..." } }
}
```

```json
{
  "type": "tool.completed",
  "nodeId": "node-uuid",
  "toolId": "tool-uuid",
  "result": { "ok": true },
  "error": { "message": "optional" }
}
```

## Approval contract
- `cliPermissionsMode = skip | gated`
- `agentManagementRequiresApproval` applies to `spawn_node` and `create_edge`.

### Approval event payloads (minimum)

```json
{
  "type": "approval.requested",
  "approvalId": "approval-uuid",
  "nodeId": "node-uuid",
  "tool": { "id": "tool-uuid", "name": "command", "args": { "cmd": "..." } },
  "context": "optional"
}
```

```json
{
  "type": "approval.resolved",
  "approvalId": "approval-uuid",
  "resolution": { "status": "approved | denied | modified", "modifiedArgs": { } }
}
```

## Loop safety contract
- Stall detection on repeated output/diff/verification signals.
- On stall: pause run and emit `run.stalled` with evidence.

## Event stream (WS)
Consumers must support:
- `run.patch`, `run.mode`, `run.stalled`
- `node.patch`, `node.progress`, `node.heartbeat`, `node.log`, `node.deleted`, `turn.status`
- `edge.created`, `edge.deleted`
- `handoff.sent`
- `message.user`, `message.assistant.delta`, `message.assistant.final`
- `message.assistant.thinking.delta`, `message.assistant.thinking.final`
- `tool.proposed`, `tool.started`, `tool.completed`
- `approval.requested`, `approval.resolved`
- `artifact.created`
- `telemetry.usage`

## Minimal REST endpoints
- `POST /api/runs`
- `GET /api/runs` / `GET /api/runs/:id`
- `PATCH /api/runs/:id` / `DELETE /api/runs/:id`
- `GET /api/runs/:id/events`
- `POST /api/runs/:id/nodes`
- `PATCH /api/runs/:id/nodes/:nodeId`
- `DELETE /api/runs/:id/nodes/:nodeId`
- `POST /api/runs/:id/edges`
- `DELETE /api/runs/:id/edges/:edgeId`
- `POST /api/runs/:id/chat`
- `GET /api/approvals` / `POST /api/approvals/:id/resolve`
