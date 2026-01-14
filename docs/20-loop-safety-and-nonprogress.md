# Loop Safety and Non-Progress Detection

Loops (cycles) are a core capability in vuhlp:

- `Coder ↔ Verifier`
- `Planner → Reviewer → Planner`
- `DocsWriter ↔ DocsReviewer`

But loops are also the easiest way to create:

- infinite runs
- token/cost blow-ups
- user distrust (“it’s stuck and I don’t know why”)

This document defines the **mandatory safety system** for any looping workflow.

---

## Non-negotiable requirements

When a workflow contains cycles, vuhlp MUST:

1) Enforce **budgets** (turns/iterations/time/cost).
2) Track **cycle iterations** deterministically.
3) Detect **non-progress** (stalling) and halt the loop.
4) Emit a machine-readable **halt reason** and recommended next actions.
5) Optionally **escalate to Interactive mode** when stuck.

---

## Definitions

### Cycle
A **cycle** is any strongly-connected component (SCC) in the graph with >= 2 nodes, or a self-loop.

### Loop iteration
A **loop iteration** is one completed pass where the cycle’s “driver” node (usually Coder/Planner) produces an output that (directly or indirectly) returns to itself as input.

> In practice, you can operationalize this by selecting a “cycle anchor edge” that closes the loop.

### Progress signal
A **progress signal** is an observable, low-cost indicator that the loop is converging.

Examples:
- diff content hash changed
- failing test count decreased
- acceptance checklist completed items increased
- docs completeness score increased

---

## Budget model

Budgets MUST exist at three levels:

### 1) Per-turn budget
Applies to one node invocation.

- `turnTimeoutMs`
- `maxTokens` (if API-based)

### 2) Per-node budget
Applies across all turns in a run.

- `maxTurnsPerNode`
- `maxRuntimeMsPerNode`

### 3) Per-cycle budget
Applies across a detected cycle.

- `maxCycleIterations`
- `maxCycleRuntimeMs`
- `maxCycleCost`

### Default recommended budgets (v0)
- `maxTurnsPerNode = 6`
- `maxCycleIterations = 8`
- `turnTimeoutMs = 10m`

> Defaults should be conservative. Users can override.

---

## Stall detection

### The stall detector MUST consider at least:

1) **Repeated identical outputs**
   - same `message.final` content hash N times
   - same `structured_output` hash N times

2) **No artifact change**
   - diff hash unchanged across M iterations

3) **Verification non-improvement**
   - same test failures (same set) repeats
   - failing count does not decrease for K iterations

4) **Oscillation**
   - output alternates between two states (A/B/A/B)

### Suggested thresholds
- repeated identical outputs: 2–3 times
- unchanged diff: 2 times
- unchanged failures: 2–3 iterations

### Required output on stall
When stalled, the runtime MUST emit a `loop.halted` event (or equivalent) with:

- `cycleId`
- `haltReason`: `budget_exceeded | stalled | oscillating | repeated_error | user_stop`
- `evidence`:
  - last N diff hashes
  - last N failing test signatures
  - last N node outputs (hashes)
- `suggestedActions`:
  - “switch to interactive”
  - “spawn reconciliation node”
  - “tighten context pack”
  - “update docs contract”

---

## Progress measurement: what to hash

To keep this cheap and deterministic:

- **Diff progress**: hash normalized patch text (ignore timestamps)
- **Verification progress**: hash normalized failing test identifiers
- **Docs progress**: hash normalized markdown (strip whitespace), or compute a checklist score

Store these hashes as artifacts on each iteration.

---

## Auto escalation policy

When stalled, vuhlp SHOULD support a policy:

- `onStall = pause | switch_to_interactive | spawn_reviewer | retry_with_new_provider`

Recommended default:
- `switch_to_interactive`

This matches the product goal: maximum autonomy until it genuinely needs a human.

---

## Implementation sketch

### Cycle detection
At graph materialization time:
- compute SCCs (Tarjan/Kosaraju)
- record a stable `cycleId` (sorted node IDs + sorted edge IDs)

### Iteration counting
Maintain per-cycle counters:
- `iterationCount`
- `lastProgressHash`
- `stalledCount`

Increment `iterationCount` when the cycle’s anchor edge delivers a payload back to the anchor node.

---

## Recommended UX

In the graph UI (or ASCII viz), show:
- cycle badge: `Loop 3/8`
- last halt reason if stopped
- progress trend: failing tests 7 → 4 → 2

In the node inspector, show:
- “Loop Evidence” section listing hashes and failure summaries.

---

## Related docs

- `docs/18-execution-semantics.md`
- `docs/19-join-gates-and-routing.md`
