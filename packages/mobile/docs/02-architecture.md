# Architecture

## Modules
- `GraphStore`: canonical graph state (nodes, ports, edges, selection, viewport).
- `GraphViewport`: world <-> screen transforms and helpers.
- `GraphCanvas`: Skia edges, edge previews, selection overlays.
- `GraphNodesOverlay`: React Native node cards positioned via viewport transforms.
- `GraphController`: gesture state machine and interaction rules.
- `GraphHitTest`: node, port, and edge hit testing (with simple spatial index).

## Data flow
1. Input events arrive in `GraphController`.
2. Controller updates `GraphStore` (selection, viewport, dragging state).
3. `GraphViewport` derives transforms for both `GraphCanvas` and `GraphNodesOverlay`.
4. `GraphCanvas` renders edges and previews from store state.
5. `GraphNodesOverlay` renders node cards from store state.

## State shape (suggested)
- Nodes: id, position, size, ports, metadata
- Edges: id, fromPortId, toPortId, style
- Viewport: x, y, zoom
- Interaction: selectedIds, draggingNodeId, draggingPortId, edgePreview
