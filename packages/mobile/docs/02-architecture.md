# Architecture

## Modules
- `GraphStore` (zustand): run state, nodes, edges, viewport, selections, approvals, chat, and layout metadata.
- `useRunConnection`: REST hydration + WebSocket event stream, writes into `GraphStore`.
- `GraphCanvas`: Skia edges + gestures (pan/pinch/double-tap), edge drag, and handoff animations.
- `NodeCard`: node UI with drag, tap select, and port handles for edge creation.
- `GraphMinimap`: Skia minimap with tap/drag navigation.
- `NodeInspector`: bottom sheet for node details + chat + tool timeline.
- `ApprovalQueue`: floating approvals with resolve actions.
- `useLayoutPersistence`: debounced layout persistence back to the daemon.

## Data flow
1. Run screen mounts `useRunConnection` to fetch the run and subscribe to WS events.
2. WS events update `GraphStore` (nodes, edges, messages, approvals, statuses).
3. `GraphCanvas` renders edges and overlays `NodeCard` instances using store state.
4. Gestures update the store (viewport, node positions, edge drag).
5. `useLayoutPersistence` posts layout patches to `/api/runs/:id`.

## State shape (current)
- Run: `run` (nullable `RunState`)
- Graph: `nodes` / `edges` as UI-enhanced contract types
- Viewport: `{ x, y, zoom }` + `viewDimensions`
- Selection: `selectedNodeId`, `selectedEdgeId`
- Edge drag: `edgeDrag` + `recentHandoffs`
- Messaging: `chatMessages`, `toolEvents`, `turnStatusEvents`
- Approvals + UI: `pendingApprovals`, `inspectorOpen`, `layoutDirty`
