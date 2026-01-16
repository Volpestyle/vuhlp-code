# Execution Semantics

This document defines **how vuhlp executes a workflow graph** (nodes + edges) in a way that is predictable, debuggable, and safe.

If vuhlp is a “graph-first orchestration system,” this doc is the contract that makes the graph *mean something*.

---

## Goals

vuhlp’s execution semantics MUST:

- Be **deterministic** given the same graph + the same inputs (to the extent provider outputs are deterministic).
- Make **why a node ran** and **what it consumed** auditable.
- Make loops **safe** (bounded, with non-progress detection).
- Support **manual control** (Interactive mode) without losing continuity.
- Support **full autonomy** (Auto mode) without thrashing.

---

## Core definitions

### Run
A **Run** is a single execution instance of a graph.

### Graph
A **Graph** is a set of:
- **Nodes** (work units)
- **Edges** (dataflow connectors)

The graph is considered **configuration**; its execution produces an **event log** and **artifacts**.

### Node
A **Node** is an addressable unit of computation.

Nodes can represent:
- an agent session (Codex / Claude / Gemini / mock)
- a tool step (verification, merge, doc sync)

### Edge
An **Edge** defines how outputs from one node are delivered to another.

### Turn
A **Turn** is one discrete “execution step” of a node.

- For CLI/provider-backed nodes: a turn is one `start` or `resume` invocation.
- A turn may stream intermediate events, but it has a clear end.

### Payload envelope
All inter-node communication uses a canonical **payload envelope** (see `docs/schemas/edge-payload.schema.json`).

This guarantees that edges can forward *structured* data (not just text) and the runtime can be deterministic.

---

## Event-sourced truth

vuhlp is event-sourced:

- The **event log** is the source of truth.
- The “current graph state” shown in UI is a **materialized view** derived from events.
- Nodes MUST NOT mutate global run state directly. They emit events and artifacts; the runtime updates state.

This enables:
- deterministic replay
- time travel/debugging (future)
- robust crash recovery

### Prompt Transparency & Auditability
To ensure full visibility into "what the agent saw," the runtime emits transparency events:

- **`turn.started`**: Emitted for *every* node execution (manual or auto).
  - Contains the **full, exact prompt** constructed for the provider (including system preambles, handoff messages, and context).
  - Allows exact reproduction of the agent's input state.
- **`handoff.sent`**: Emitted when a message traverses an edge (contains a preview).

This ensures that even in complex auto-loops, you can audit the exact context passed to every node.

---

## Node execution contract

Each node has:

- `mode`: `interactive | auto`
- `control`: `manual | automatic` (optional override)
- `trigger`: when it should run (see below)
- `maxInFlight`: max concurrent turns for this node (default 1)
- `budgets`: (turns, time, cost)
- `policy`: tool permissions + workspace constraints

### Trigger modes
A node’s trigger mode MUST be one of:

- `manual_only`: node runs only when the user triggers a turn.
- `on_any_input`: run when **any** new input arrives.
- `scheduled`: runtime-controlled periodic/tick-based runs.

**Strong recommendation:**
- Let the Orchestrator manage fan-in synchronization logic.

### Inputs
Nodes receive inputs as a list of payload envelopes.

Each input envelope has:
- a stable `payloadId` (UUID)
- provenance (`fromNodeId`, `edgeId`)
- typed content: message / structured / artifacts / status

Nodes SHOULD treat inputs as immutable.

### Outputs
A node turn produces **zero or more** output envelopes.

- “Zero output” is valid (e.g., node ran and concluded no action).
- Outputs MUST be stored as artifacts/events and then delivered downstream via edges.

### Output selection
Agent nodes commonly produce multiple useful artifacts:

- assistant final message
- structured JSON (if schema-enforced)
- diffs/patches
- logs and verification results

To avoid ambiguity, each node has an `outputSelector`:

- `message.final` (default)
- `structured_output`
- `artifacts:diff`
- `artifacts:logs`
- `composite` (message + structured + selected artifacts)

**Rule:** the runtime MUST know which portion(s) of node output are forwarded on edges.

---

## Edge delivery semantics

Edges define *how outputs move*.

Each edge has:

- `deliveryMode`:
  - `latest` — keep only the latest undelivered payload (overwrites older)
  - `queue` — FIFO queue of payloads
  - `debounce(ms)` — coalesce bursts; deliver only after quiet period
  - `drop_if_busy` — deliver only if downstream is idle
- `maxBuffered`: maximum buffered payloads (default depends on delivery mode)
- `transform`: optional mapping/filter on payload (e.g., extract a diff)

### Acknowledgement
Delivery to a downstream node MUST be acknowledged by the runtime:

- `DELIVERED`: payload was queued/attached to node inputs
- `CONSUMED`: node started a turn consuming a specific payload set

This is required for determinism and for explaining behavior (“why didn’t it run?”).

### Dedupe
Edges SHOULD support dedupe by payload hash if configured:

- `dedupeBy`: `payloadId | contentHash | none`

This prevents repeated identical messages from thrashing loops.

---

## Scheduling

The scheduler is responsible for selecting runnable nodes.

### Runnable conditions
A node is runnable if:

- Run mode is `AUTO` and node is `auto` (and not manual override)
- Node is not at `maxInFlight`
- Node trigger conditions are satisfied:
  - `on_any_input`: at least one unconsumed input available
  - `scheduled`: tick interval reached
  - `manual_only`: NEVER runnable by scheduler
- Node is not blocked (approval/dependency)

### Global mode gates
Global Workflow Mode (`Planning` vs `Implementation`) MUST act as a gate:

- In **Planning**:
  - nodes must treat codebase as read-only
  - write targets restricted to `/docs` (or configured doc root)
- In **Implementation**:
  - code changes allowed per node policy

The runtime MUST pass the global mode into every node turn context.

### Interactive mode
When the run is in `INTERACTIVE` mode:

- The scheduler MUST NOT start new node turns.
- Users can still trigger manual turns.

---

## Auto continuation: avoid “repeat the initial prompt”

A naïve auto-loop re-sends the initial prompt each iteration.

This tends to cause:
- duplicated work
- plan drift
- higher token usage

### Recommended semantics: objective + ticks
In Auto mode, treat the node’s initial prompt as a stable **Objective**, then drive iteration with **Tick inputs**.

A tick is a compact delta:

- what changed since last turn
- what verification says
- what remains

Example tick envelope (`kind: tick`):

```json
{
  "kind": "tick",
  "objective": "Make tests pass and satisfy /docs/ACCEPTANCE.md",
  "delta": {
    "newArtifacts": ["artifact://logs/test-failures.txt"],
    "status": {"tests": "fail", "failing": 2},
    "openItems": ["Fix websocket reconnect backoff"],
    "blockedOn": []
  },
  "constraints": {"mode": "implementation", "workspace": "worktree"}
}
```

The node is asked to continue **from the current state**, not re-plan from scratch.

> Note: If v0 currently replays the initial prompt each loop, treat tick-based continuation as the target semantics for v1.

---

## Deterministic ordering

When multiple payloads are eligible for delivery/consumption:

- Sort by `ts` (event time), then by `payloadId`.
- The runtime MUST apply a deterministic tie-breaker.

This ensures `vulp --viz` and replays are stable.

---

## Examples

### 1) Chain (A → B)
- Edge delivery: `latest`
- B trigger: `on_any_input`

Behavior:
- whenever A produces a new payload, B runs once on the latest payload.

### 2) Loop (Coder ↔ Verifier)
- Coder: `on_any_input` (consumes failures)
- Verifier: `on_any_input` (consumes diffs)
- Loop safety: max iterations, stall detection

Behavior:
- Coder produces diff → Verifier runs tests → failures return → Coder patches → ... until pass.

### 3) Fan-in (ResearchA + ResearchB → Synchronizer)
- Orchestrator waits for both research nodes to complete.
- Orchestrator spawns Synthesizer to consume the aggregated payload.

---

## Required implementation hooks

To implement this spec cleanly, vuhlp SHOULD expose:

- a deterministic `GraphState` materializer
- an explicit `DeliveryQueue` per edge
- per-node `InputBuffer` and `InFlightTurns`
- standardized payload envelope and context pack types

See also:
- `docs/20-loop-safety-and-nonprogress.md`
- `docs/21-context-packs.md`
