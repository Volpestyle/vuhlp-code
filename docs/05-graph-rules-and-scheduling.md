# Graph Rules and Scheduling

This document defines the graph execution rules, edge behavior, and scheduling loop.

## Objectives
- Graph is the source of orchestration behavior.
- Deterministic input delivery and node execution.
- Full visibility of node state and inputs.

## Graph model
A run is a graph of nodes and edges. Nodes execute in turns. Edges describe communication paths; envelopes are created explicitly.

### Edge types
- `handoff`
- `report`

### Directionality
- Edges can be bidirectional or directional.
- Default is bidirectional.

## Core rules
1) Inputs are auto-consumed (queued to inbox, not interrupting).
2) No implicit join nodes.
3) Node turns are discrete.
4) All payload delivery is logged.

## Scheduling model

### High-level loop
- Scheduler scans runs with `status=running`.
- A node is runnable when:
  - status is `idle`
  - it has inbox inputs, queued messages, a pending turn, or an auto-prompt queued

### Turn lifecycle
1) Select node.
2) Consume inbox inputs + queued messages.
3) Build prompt (system + role + mode + task).
4) Execute provider turn.
5) Capture prompt artifacts; dispatch tool events.
6) Dispatch explicit envelopes (if any).
7) Update node status.

### Auto reprompt (AUTO mode)
- Only the orchestrator is auto-reprompted.
- Triggered when the orchestrator is idle with no inputs.

## Queue semantics
- Inbox is FIFO.
- Inputs accumulate while a node is running.

## Edge delivery
- Envelopes are only created via `send_handoff` (or initial payloads from `spawn_node`).
- `send_handoff` requires an edge.
- Delivery is deterministic and ordered.

## Node state model (minimal)
- `idle`
- `running`
- `blocked`
- `failed`

These statuses must be visible in the UI.
