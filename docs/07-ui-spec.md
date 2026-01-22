# UI Spec

This document defines the UI and interaction model for the current implementation.

## Rendering
- Graph canvas is implemented with **Cytoscape**.
- Nodes are draggable cards with 4 ports (top/right/bottom/left).
- Edges are directional or bidirectional.

## Core UX modes

1) **Graph + Inspector (Default)**
- Graph canvas in the center.
- Right-side inspector for the selected node.
- Node windows show live activity and short summaries.

2) **Center Stage (Focus)**
- Focus on the selected node (toggle with `f`).

3) **Overview**
- Zoomed-out view for the entire graph.

## Keyboard shortcuts
- `Esc`: Deselect node/edge
- `Delete` / `Backspace` / `Shift+Q`: Delete selected node or edge
- `f`: Toggle center stage for selected node
- `Shift+D`: Duplicate selected node
- `i`: Cycle input neighbors of selected node
- `o`: Cycle output neighbors of selected node

## Graph interactions
- Drag from any port to another node to create an edge.
- Edges can be directional or bidirectional.
- Edge routing is handled by the Cytoscape layout + custom styling.

## Node inspector requirements
The inspector shows:
- Status and live activity
- Prompt artifacts
- Incoming/outgoing handoffs
- Tool events
- Artifacts list
- Controls: start/stop, interrupt, reset

## Node card requirements
Each node card shows:
- Provider badge
- Role label
- Status
- Short live summary
- Last activity timestamp

## Run-level controls
- Global AUTO / INTERACTIVE toggle
- Global PLANNING / IMPLEMENTATION toggle

## Edge labeling
- Orchestrator -> node: `handoff` (label `task` by default)
- Node -> orchestrator: `report` (label `report` by default)
