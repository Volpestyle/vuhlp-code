# Custom interface mode

Custom interface mode refers to the daemon-driven UI + streaming event pipeline. The daemon spawns provider CLIs, normalizes output, and exposes events over WebSocket.

## Event model (current)

Run events:
- `run.patch`
- `run.mode`
- `run.stalled`

Node events:
- `node.patch`
- `node.progress`
- `node.heartbeat`
- `node.log`
- `node.deleted`
- `turn.status`

Message events:
- `message.user`
- `message.assistant.delta`
- `message.assistant.final`
- `message.assistant.thinking.delta`
- `message.assistant.thinking.final`

Tool events:
- `tool.proposed`
- `tool.started`
- `tool.completed`

Approvals:
- `approval.requested`
- `approval.resolved`

Graph events:
- `edge.created`
- `edge.deleted`
- `handoff.sent`
- `artifact.created`

Telemetry:
- `telemetry.usage`

## Approvals

When `cliPermissionsMode` is `gated`, tool proposals are routed through the approval queue. The daemon exposes:
- `GET /api/approvals`
- `POST /api/approvals/:id/resolve`

## Provider session continuity

Session IDs are captured from provider adapters when available. CLI adapters keep stdin open for stateful streaming when supported.

## API reference

See `docs/12-api.md` for REST + WS details.
