# ASCII graph visualization (`vulp viz`)

Goal: render a deterministic, readable ASCII representation of the current run graph.

Constraints:
- must be deterministic from `graph.json` (no random layout)
- should handle DAGs well; cycles allowed but rendered with back-edges
- should show node statuses and types
- should remain readable in 120–200 column terminals

---

## Inputs

- `graph.json` nodes + edges
- per-node status (RUNNING/BLOCKED/DONE/ERROR)
- optional: last output summary line

---

## Deterministic layout algorithm (v0)

### Step 1: Normalize graph
- Build adjacency lists.
- Identify strongly connected components (SCCs) to detect cycles.
- Condense SCCs to a DAG of components.

### Step 2: Topological layering (on condensed DAG)
- Kahn’s algorithm for topo order.
- Assign each component a layer (longest-path or BFS from sources).

Determinism: when multiple nodes are eligible, sort by `node_id`.

### Step 3: Within-layer ordering
- Sort components by:
  1) number of downstream edges (descending)
  2) node_id (ascending)

### Step 4: Expand SCCs
For each SCC with >1 node:
- render as a boxed subgraph:
  `[cycle: A,B,C]`
- edges crossing SCC boundaries attach to the box.

This avoids tangled ASCII.

---

## Rendering format

### Compact “list” mode (always available)
A simple deterministic view:

```
RUN run_...  mode=AUTO
[orchestrator] orch  RUNNING
  -> impl-a (codex) READY
  -> impl-b (claude) BLOCKED(manual)
[verifier] verify  IDLE
```

This is easy and robust.

### ASCII DAG mode (primary)
Render by layers:

```
L0:  (orch:RUNNING)
        |\
        | \
L1:  (impl-a:READY)   (impl-b:BLOCKED)
        |                 |
L2:        (verify:IDLE)
```

Use a fixed set of ASCII connectors:
- `|` vertical
- `-` horizontal
- `\` and `/` diagonals
- `>` arrowheads

Determinism:
- fixed spacing per column
- stable column assignment per layer order

---

## Status styling
Use minimal coloring (optional):
- RUNNING = yellow
- DONE = green
- ERROR = red
- BLOCKED = magenta

But ASCII must still work without ANSI.

Represent in text:
- `node_id:STATUS`
- `BLOCKED(manual)` or `BLOCKED(approval)` if known

---

## `--watch` mode
Implementation strategy:
- re-render the full graph every N seconds
- clear screen between frames (ANSI clear)
- do not “diff update” in v0

---

## Optional “graphviz bridge” (v1)
If `dot` is installed:
- emit DOT
- call `dot -Tplain`
- convert coords to ASCII

This yields better layout but adds dependency.

