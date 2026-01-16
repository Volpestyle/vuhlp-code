# Graph Rules and Scheduling (v2)

This document defines the graph execution rules, edge behavior, and scheduling loop. The goal is to keep behavior deterministic, visible, and safe without imposing hard run-length caps.

## Objectives
- Define the graph as the source of orchestration behavior.
- Guarantee deterministic input delivery and node execution.
- Preserve visibility of node states and inputs.
- Avoid hidden ordering or implicit joins.

## Graph model
A run is a graph of nodes and edges. Nodes execute in turns. Edges deliver payload envelopes.

### Node types
- Orchestrator
- Task agent
- Verifier (optional specialization)

### Edge types
- `handoff`: work or context passed to another node.
- `report`: results passed back to a supervisor.

### Directionality
- Edges can be **bidirectional** or **directional**.
- Default is **bidirectional**.

## Core rules
1) **Inputs are auto-consumed** (queued to inbox, not interrupting).
2) **No implicit join nodes**. Fan-in is orchestrator-managed.
3) **Node turns are discrete**. A node is either running or idle.
4) **All payload delivery is logged**.

## Scheduling model

### High-level loop
- The scheduler scans for runnable nodes.
- A node is runnable when:
  - It is idle (queued).
  - It has inbox inputs or a user message.
  - It is not blocked by approvals.

### Turn lifecycle
1) Select node.
2) Consume inbox inputs for that turn.
3) Build prompt delta for the turn (new inputs + mode + refs).
   - First turn (or after reset/provider switch): send full prompt.
   - Subsequent turns: send delta only, rely on CLI session continuity.
   - Always reconstruct and log the full effective prompt for auditability.
4) Execute provider turn.
5) Capture outputs and diffs as artifacts.
6) Dispatch outgoing envelopes.
7) Update node status.

## Queue semantics
- Each node has an inbox.
- Inputs are appended FIFO.
- If multiple inputs arrive, they are consumed in order.
- If a node is running, inputs accumulate until the next turn.

## Auto-consumption vs interruption
- Auto-consumption **does not interrupt** a running node.
- Only explicit user interrupts can pause a node mid-turn.

## Edge delivery
- Each edge appends envelopes to the downstream inbox.
- Delivery is deterministic and ordered.
- The runtime logs delivery events for audit.

## Output selection
Nodes can emit:
- A final message (required).
- Structured output (optional).
- Artifacts (diffs, logs, reports).

Outgoing envelopes should include:
- A short message summary.
- A reference to artifacts (diffs must be included if present).

## Node state model (minimal)
- `idle`: waiting for input.
- `running`: executing a turn.
- `blocked`: waiting on approval or manual input.
- `failed`: last turn failed.

These statuses must be visible in the UI.

## Determinism requirements
- Input ordering is stable.
- Prompts are logged per turn.
- All envelope deliveries are recorded.

## Example run flow (ASCII)

```
Node A (running)
  -> emits diff + summary
  -> envelope queued to Node B

Node B (idle)
  -> consumes inbox
  -> runs next turn
```

## Open questions
- None. Update as scheduling features evolve.
