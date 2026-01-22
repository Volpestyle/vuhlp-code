# Communication and Context

This document defines how agents communicate and how the UI tracks real-time agent state.

## Objectives
- Standardize handoff payloads.
- Keep payloads small and structured.
- Preserve observability.
- Track connection state and streaming output.

## Communication model
Agents communicate through explicit **handoff envelopes**. Edges define allowed paths; envelopes are created only when a node calls `send_handoff`.

### Envelope (canonical payload)

```
{
  "kind": "handoff",
  "id": "payload-uuid",
  "fromNodeId": "node-a",
  "toNodeId": "node-b",
  "createdAt": "2026-01-01T00:00:00Z",
  "payload": {
    "message": "Short summary",
    "structured": { "key": "value" },
    "artifacts": [
      { "type": "diff", "ref": "artifact://diff/123" }
    ],
    "status": { "ok": true, "reason": "tests-pass" },
    "response": { "expectation": "optional", "replyTo": "node-a" }
  }
}
```

### Required fields
- `kind` (`handoff`)
- `id`
- `fromNodeId`, `toNodeId`
- `createdAt`
- `payload.message`

### Optional fields
- `payload.structured`
- `payload.artifacts`
- `payload.status`
- `payload.response`
- `contextRef`
- `meta`

## Handoff delivery
- `send_handoff` requires an edge between sender and receiver.
- Handoffs are queued to the target node inbox.
- Inputs are auto-consumed on the next turn (no interruption by default).
- Delivery is deterministic and ordered.

## User messages (interrupt vs queue)
- Messages are queued for the next turn.
- To interrupt a running node, call `POST /api/runs/:id/nodes/:nodeId/interrupt`.

## Real-time connection state
The UI shows per-node connection state:
- Connected (streaming output)
- Idle
- Disconnected

### Required signals
- Provider session id (when available)
- Last activity timestamps
- Streaming status

## UI observability requirements
For every node, the inspector must show:
- Incoming and outgoing handoffs
- Tool usage events
- Artifacts list
- Prompt artifacts
- Streaming output
