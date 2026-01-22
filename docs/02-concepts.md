# Concepts

## Run

A **Run** is a single orchestration session. It owns:
- nodes and edges
- run status (`queued`, `running`, `paused`, `stopped`, `completed`, `failed`)
- run mode (`AUTO` / `INTERACTIVE`)
- global mode (`PLANNING` / `IMPLEMENTATION`)
- artifacts and event log

Runs are persisted under the configured `dataDir` (default `data`).

## Node

A **Node** is a single agent session backed by a provider (Codex, Claude, Gemini). Nodes have:
- a status (`idle`, `running`, `blocked`, `failed`)
- a role label and optional custom prompt
- capabilities and permissions
- a session config (resume + reset commands)

Nodes are runnable when they are idle and have inbox inputs, queued messages, or pending turn state.

## Edge

An **Edge** connects two nodes and carries handoff payloads. Edges are:
- `handoff` (work/context exchange)
- `report` (results back to a supervisor)

Edges can be bidirectional. Handoffs are queued per-node (no edge-level inbox).

## Modes

### Run mode (scheduler)
- **AUTO**: the scheduler can auto-reprompt the orchestrator when idle.
- **INTERACTIVE**: the scheduler only runs when there are queued inputs.

### Global mode (agent behavior)
- **PLANNING**: prompts instruct docs-only edits; vuhlp tool execution enforces docs-only writes.
- **IMPLEMENTATION**: code edits are allowed (subject to node capabilities).

## Handoffs

When a node calls `send_handoff`, an envelope is queued to the target node.
Envelopes are consumed on the next turn.

```json
{
  "kind": "handoff",
  "fromNodeId": "node-a",
  "toNodeId": "node-b",
  "payload": {
    "message": "Summary",
    "structured": { "key": "value" }
  }
}
```

`send_handoff` requires an edge between sender and receiver.

## Chat messages

Chat messages can target a run or a specific node. Messages are queued for the next turn.
To interrupt a running node, use the interrupt endpoint (`POST /api/runs/:id/nodes/:nodeId/interrupt`).
