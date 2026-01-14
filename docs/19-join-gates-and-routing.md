# Join, Gates, and Routing

Graphs become powerful (and predictable) when **fan-in and conditional branching** are explicit.

This doc defines two core primitives that turn “patterns” into reliable, deterministic behavior:

- **JoinGate**: deterministic fan-in aggregation (wait for multiple upstreams)
- **Router**: deterministic branching (send payloads to different downstream edges)

---

## Why this is required

Without first-class join semantics, a downstream “summarizer” node will typically:

- run **once per upstream output** (double execution), or
- block forever (no “done” signal), or
- rely on brittle heuristics (“if I’ve seen two messages, proceed”).

Similarly, without routing, users implement branching by prompt text, which is:
- hard to debug
- non-deterministic
- expensive (wasted turns)

---

## JoinGate node

A **JoinGate** is a node that waits for multiple upstream inputs, then emits a **single aggregated output**.

### JoinGate responsibilities

A JoinGate MUST:

1) Define which inputs it is waiting for.
2) Decide when the join condition is satisfied.
3) Emit an aggregated payload envelope with **full provenance**.
4) Remain deterministic under concurrency.

### Join policies

Supported policies:

- `all`: wait for all required inputs
- `any`: proceed on first input
- `quorum(k)`: proceed when any `k` inputs arrive
- `timeout(ms)`: proceed when time expires (with partial result)

JoinGate config example:

```json
{
  "type": "join_gate",
  "id": "join.research",
  "policy": {"kind": "all"},
  "requiredInputs": [
    {"fromNodeId": "research.a", "edgeId": "e1"},
    {"fromNodeId": "research.b", "edgeId": "e2"}
  ],
  "timeoutMs": 600000,
  "onTimeout": "emit_partial"  
}
```

### Output envelope

JoinGate outputs a payload envelope:

- `kind: "join"`
- `payload.aggregated[]`: list of upstream payloads
- `payload.provenance[]`: `(fromNodeId, edgeId, payloadId, ts)` for each input
- `payload.joinStatus`: `complete | partial | timeout`

This makes downstream nodes predictable: they always get one “package.”

### Partial joins

If `timeout` is used:

- JoinGate MUST set `joinStatus = "partial"` or `"timeout"`.
- Downstream nodes MUST be able to inspect join status and decide to proceed or escalate.

Recommended pattern:
- Use partial joins only for exploratory research.
- Avoid partial joins for code merges.

---

## Router node

A **Router** evaluates each incoming payload and forwards it to one or more downstream edges.

### Router responsibilities

A Router MUST:

- Evaluate a deterministic set of rules.
- Decide which edge(s) receive the payload.
- Emit `handoff.sent` events per routed edge.

### Rule types

Rules SHOULD support these selectors:

- `status.ok == true/false`
- `payload.kind == "diff" | "report" | "verification" | ...`
- `structured_output.<jsonpath>` equals / contains
- `message.final` regex match
- artifact presence (diff/log/test)

Router config example:

```json
{
  "type": "router",
  "id": "router.verify",
  "rules": [
    {
      "when": {"kind": "verification", "status": {"tests": "pass"}},
      "sendTo": ["edge.to.finalize"]
    },
    {
      "when": {"kind": "verification", "status": {"tests": "fail"}},
      "sendTo": ["edge.to.coder"]
    }
  ],
  "default": ["edge.to.orchestrator"]
}
```

### Determinism requirements

- Rules MUST be evaluated in a stable order.
- If multiple rules match, behavior MUST be defined:
  - `first_match` (default), or
  - `all_matches`

---

## Reconciliation and merge as explicit nodes

A “sub-agent changes reconciliation” step is **not wasted tokens** when it produces an actionable integration artifact.

To prevent waste, reconciliation SHOULD be expressed as a node that outputs one of:

- `merged_diff` (preferred)
- `merge_plan + conflict_list`

### When to insert a reconciliation node

Trigger reconciliation when any of the following is true:

- two or more upstream diffs touch overlapping files
- verification failures implicate multiple upstream changes
- the task requires a single coherent API/contract across modules

Otherwise, skip it.

---

## UI implications

- JoinGate nodes should show a “waiting for inputs” checklist.
- Router nodes should display which rule fired.
- Reconciliation nodes should display:
  - overlap score
  - conflict list
  - final merged diff

See also:
- `docs/18-execution-semantics.md`
- `docs/20-loop-safety-and-nonprogress.md`
