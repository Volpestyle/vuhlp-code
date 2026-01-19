# Communication and Context

This document defines how agents communicate, how context is packaged, and how the UI tracks real-time agent state. The goal is to keep handoffs fast, deterministic, and token-efficient while preserving full observability.

## Objectives
- Standardize handoff payloads across providers.
- Keep payloads small and structured.
- Make context portable and auditable.
- Ensure the UI can show what each agent consumed and produced.
- Support real-time connection state and streaming outputs.

## Communication model
Agents communicate through explicit **handoff envelopes**. Edges define allowed communication paths; envelopes are only created when an agent calls `send_handoff` (or when `spawn_node` delivers its initial payload). Outputs do not auto-generate envelopes. Inputs are always auto-consumed once delivered.

### Envelope (canonical payload)
Each envelope is a structured JSON object with stable fields:

```
{
  "kind": "handoff",
  "id": "payload-uuid",
  "fromNodeId": "node-a",
  "toNodeId": "node-b",
  "createdAt": "2026-01-01T00:00:00Z",
  "payload": {
    "message": "Short human-readable summary",
    "structured": { "key": "value" },
    "artifacts": [
      { "type": "diff", "ref": "artifact://diff/123" },
      { "type": "log", "ref": "artifact://log/456" }
    ],
    "status": { "ok": true, "reason": "tests-pass" },
    "response": { "expectation": "optional", "replyTo": "node-a" }
  },
  "contextRef": "contextpack://pack/789",
  "meta": { "priority": "normal" }
}
```

### Required fields
- `kind` (string): `handoff` or `signal`.
- `id` (string): unique payload id.
- `fromNodeId`, `toNodeId`.
- `createdAt`.
- `payload.message`: short summary text.

### Optional fields
- `payload.structured`: structured JSON output.
- `payload.artifacts`: artifact references (diffs, logs, reports).
- `payload.status`: pass/fail or decision info.
- `payload.response`: response expectation (`none`, `optional`, `required`) and optional reply target.
- `contextRef`: a reference to a stored context pack.

## Context packs
Context packs are compact, structured bundles to avoid bloated prompts.

### When to use
- Large upstream outputs.
- Multi-step workflows where context must persist across turns.
- Token-sensitive providers.

### Context pack structure

```
{
  "packId": "uuid",
  "runId": "run-123",
  "nodeId": "node-abc",
  "createdAt": "2026-01-01T00:00:00Z",
  "goal": "Implement feature X",
  "definitionOfDone": ["criteria1", "criteria2"],
  "globalMode": "IMPLEMENTATION",
  "nodeMode": "AUTO",
  "docsRoot": "/docs",
  "docRefs": [
    { "path": "docs/PLAN.md", "excerpt": "..." }
  ],
  "repoFacts": {
    "language": "typescript",
    "packageManager": "pnpm"
  },
  "relevantFiles": [
    { "path": "src/foo.ts", "summary": "entry point" }
  ],
  "inputs": [
    { "payloadId": "payload-uuid" }
  ],
  "artifacts": [
    { "id": "artifact-123", "kind": "diff" }
  ],
  "constraints": {
    "noNewDependencies": true
  }
}
```

### Context pack rules
- Packs should be small (target 2–6k tokens).
- Prefer references over full content.
- Every pack must be stored as an artifact and referenced by `contextRef`.
- Packs can be merged or appended by the orchestrator.

## Token efficiency strategy
- Avoid re-sending full transcripts.
- Pass short summaries in envelopes.
- Store long outputs as artifacts and reference them.
- Send prompt deltas when session continuity is active.\n+- Always reconstruct and log the full effective prompt for audit.\n+- Build prompts from system + role + mode + pack.

## Handoff delivery
- Handoffs are created explicitly via `send_handoff` (or `spawn_node` initial payloads).
- `send_handoff` requires an edge between the sender and receiver (directional or bidirectional).
- Inputs are auto-consumed by the target node, but **not** interrupting by default.
- Each node maintains an inbox; queued inputs are consumed on the next turn.
- The system logs which inputs were consumed in each turn.
- Handoff delivery is deterministic and ordered.

## User messages (interrupt vs queue)
- Users can **interrupt** a node (pause current execution and inject a message).\n+- Users can **queue** a message (deliver it to the inbox for the next turn).\n+- Interrupts are explicit and should be visible in the UI and event log.

## Spawn command routing
A spawn request is a **payload**, not an instruction to auto-create nodes. The runtime only spawns after approval and only if the node has `spawnNodes` enabled.

## Waiting and synchronization
There are no join nodes. Fan-in and waiting are orchestrator-managed:
- The orchestrator waits for specific node outputs.
- The UI shows which nodes are pending and why.

## Real-time connection state
The UI must show each node’s live connection state:
- Connected (streaming output is active).
- Idle (waiting for input).
- Disconnected (CLI session ended or error).

### Required signals
- Provider session id (if available).
- Last activity timestamp.
- Current stream status (writing/reading).

## UI observability requirements
For every node, the inspector must show:
- Incoming handoffs (raw envelope data).
- Outgoing handoffs.
- Diffs produced by the node.
- Artifacts list.
- Tool usage events.
- Prompt log for each turn.

## ASCII flow (handoff + context)

```
Node A calls send_handoff
  |
  v
Envelope (summary + artifact refs + contextRef)
  |
  v
Node B input (auto-consumed)
  |
  v
Node B turn prompt = system + role + mode + context
```

## Open questions
- None. Update as payload structure evolves.
