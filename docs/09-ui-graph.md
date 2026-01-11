# UI and graph visualization

The v0 UI is a static web app served by the daemon.

## Graph renderer

v0 uses **Cytoscape.js** (loaded via CDN) to render:

- nodes
- edges
- status styles
- click-to-inspect behavior

## Visual semantics

- Nodes are labeled by role + provider.
- Edges animate briefly when new handoffs occur.
- Node status changes color by class:
  - queued / running / completed / failed

## Node inspector

Selecting a node shows:

- inputs (instructions/context)
- progress log (normalized events)
- artifacts (links to files served by daemon)
- summary (best-effort)

## “Thoughts”

v0 does not display raw chain-of-thought.
Instead, it shows:

- “Reasoning summary” fields when the provider returns them
- Observable actions:
  - commands executed
  - files changed
  - diffs

## Future improvements

- Nested orchestrator subgraphs
- Timeline view (spans)
- Filters (provider, role, status)
- Diff viewer inline with syntax highlighting
