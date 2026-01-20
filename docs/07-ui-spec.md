# UI Spec

This document defines the non‑negotiable UI and interaction model. The UI should feel like a multi‑terminal graph of agents with full observability.

## Rendering (non‑negotiable)
- Use a **custom WebGL renderer** for the graph canvas.
- Avoid off‑the‑shelf graph renderers (e.g., Cytoscape) for the main canvas.
- The renderer must support smooth edge routing, port snapping, and live animation.

## Core UX modes (non‑negotiable)
The UI has three viewing modes:

1) **Fullscreen Node Chat**
- One node fills the screen.
- Real‑time streaming chat is visible.
- Full typing interaction.

2) **Graph + Inspector (Default)**
- Graph canvas in the center.
- Right‑side inspector for the selected node.
- Node cards show live activity and short summaries.
- You can see live chat scroll in small windows but cannot type into them.

3) **Collapsed Overview**
- All nodes collapse into minimal cards.
- Designed to see the entire graph at once.
- No direct typing; use inspector only.

## Keyboard shortcuts
- `f`: Toggle fullscreen for selected node.
- `f` again: Return to graph view.
- `shift+f`: Collapse all nodes (overview).
- `shift+n`: New node.
- `shift+d`: Duplicate selected node.
- `delete`: Delete selected node or edge.
- `enter`: Start/stop selected node.

## Graph interactions
- Nodes have 4 ports (top, right, bottom, left).
- Drag from any port to any other node to create an edge.
- Edges can be directional or bidirectional.
- The shortest path rule applies: edges automatically attach to the port closest to the target.
- As nodes move, edges smoothly re-route and “spin” around the node to keep the shortest clean line.

## Node inspector requirements
The inspector must show, per node:
- Status and live activity.
- Prompt log for each turn.
- Incoming handoffs (raw envelopes).
- Outgoing handoffs.
- Diffs produced by the node (non‑negotiable).
- Artifacts list with quick preview.
- Tool usage events.
- Connection properties (edges + labels).
- Controls: start/stop process, pause running turn (interrupt), queue message, reset context.
- Typing `/new` or `/clear` in chat triggers reset context (clears chat + starts a fresh session).

## Node card requirements
Each node card must show:
- Provider badge (Codex / Claude / Gemini / other).
- Role label.
- Status badge (idle/running/blocked/failed).
- Short live summary (3–6 words).
- Last activity timestamp.

## Connection state visibility
Each node must display:
- Connected / idle / disconnected state.
- Session id (if available).
- Active streaming indicator when output is flowing.

## Run‑level controls
- Global Auto/Interactive toggle for orchestration.
- Global Planning/Implementation toggle.
- Master Start/Stop controls.

## Edge labeling
- Default edges created by orchestrator:
  - Orchestrator -> node: `handoff` (label “task” by default).
  - Node -> orchestrator: `report` (label “report” by default).
- User can override edge labels.

## Visual motion
- Smooth transitions when nodes move or edges reroute.
- Handoff activity can be represented with subtle animated pulses.

## UI layout persistence
- Node positions persist per run.
- Graph zoom and pan persist per run.

## Open questions
- None. Update if new UI interactions are added.
