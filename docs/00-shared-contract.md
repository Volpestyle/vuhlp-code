# Shared Contract (Build Alignment)

Use this as the single source of truth for runtime ↔ provider ↔ UI integration. If anything conflicts, this contract wins.

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
Event logs are append-only JSONL files, ordered by write time.

## Run state (minimum fields)
```json
{
  "id": "run-uuid",
  "contractVersion": "1",
  "status": "queued | running | paused | completed | failed",
  "phase": "BOOT | EXECUTE | VERIFY | DOCS_SYNC | DONE",
  "mode": "AUTO | INTERACTIVE",
  "globalMode": "PLANNING | IMPLEMENTATION",
  "createdAt": "2026-01-01T00:00:00Z",
  "updatedAt": "2026-01-01T00:00:00Z",
  "nodes": { "nodeId": { "...": "..." } },
  "edges": { "edgeId": { "...": "..." } },
  "artifacts": { "artifactId": { "...": "..." } }
}
```

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
    "spawnNodes": false,
    "writeCode": true,
    "writeDocs": true,
    "runCommands": true,
    "delegateOnly": false
  },
  "permissions": {
    "cliPermissionsMode": "skip | gated",
    "spawnRequiresApproval": true
  },
  "session": {
    "sessionId": "provider-session-id",
    "resetCommands": ["/new", "/clear"]
  },
  "connection": {
    "status": "connected | idle | disconnected",
    "streaming": true,
    "lastHeartbeatAt": "2026-01-01T00:00:00Z",
    "lastOutputAt": "2026-01-01T00:00:00Z"
  },
  "inboxCount": 0
}
```

Optional node fields are recommended for UI responsiveness:
- `connection` describes live provider state.
- `inboxCount` shows queued inputs.

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
    "status": { "ok": true, "reason": "tests-pass" }
  },
  "contextRef": "contextpack://pack/789"
}
```

### Artifact reference scheme
- Use `artifact://<artifactId>` for all artifact references.
- The UI resolves artifacts to local paths for preview/download.

## Inbox semantics
- Inputs are queued per node and consumed on the next turn.
- No interruption by default.
- User can explicitly interrupt or queue.

## User message record (if stored)
```json
{
  "id": "msg-uuid",
  "runId": "run-uuid",
  "nodeId": "optional-node-uuid",
  "role": "user | assistant | system",
  "content": "message text",
  "interrupt": true,
  "createdAt": "2026-01-01T00:00:00Z"
}
```

## Prompting contract
- First turn or after reset/provider switch: full prompt is sent.
- Subsequent turns: delta prompt sent; session continuity assumed.
- Full effective prompt is always reconstructed and logged.

### Prompt artifacts (required)
- `prompt.full.txt` (full effective prompt)
- `prompt.blocks.json` (system/role/mode/task/override split)

## Artifacts (non-negotiable)
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

- Every completed turn must emit a diff artifact (empty or "no changes" allowed).
- Node inspector must show per-node diffs.

### Diff artifact metadata (recommended)
```json
{
  "filesChanged": ["path/a.ts", "path/b.ts"],
  "summary": "short change summary"
}
```

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
- Gated mode: provider pauses -> approval event -> UI -> user -> response forwarded.
- Spawn approvals:
  - Non-orchestrator nodes always require approval.
  - Orchestrator approval is policy-controlled (`spawnRequiresApproval`).

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
- Stall detection on repeated output hash / diff hash / verification failures.
- On stall: pause orchestration + emit `run.stalled` with evidence.

## Event stream (WS)
Consumers must support:
- `run.patch`, `run.phase`, `run.mode`, `run.stalled`
- `node.patch`, `node.progress`
- `edge.created`, `edge.deleted`
- `handoff.sent`
- `message.user`, `message.assistant.delta`, `message.assistant.final`
- `tool.proposed`, `tool.started`, `tool.completed`
- `approval.requested`, `approval.resolved`
- `artifact.created`

## Minimal REST endpoints
- `POST /api/runs` -> create run
- `GET /api/runs` -> list runs
- `GET /api/runs/:id` -> run snapshot
- `GET /api/runs/:id/events` -> event history
- `POST /api/runs/:id/nodes` -> create node
- `PATCH /api/runs/:id/nodes/:nodeId` -> update node
- `POST /api/runs/:id/edges` -> create edge
- `DELETE /api/runs/:id/edges/:edgeId`
- `POST /api/runs/:id/chat` -> interrupt/queue
- `GET /api/approvals` / `POST /api/approvals/:id/resolve`
