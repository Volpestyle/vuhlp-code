# UI and graph

The UI is a graph editor plus node inspector.

## Graph canvas

- Implemented with Cytoscape and an HTML overlay layer.
- Nodes are draggable cards with 4 ports: input (top), output (bottom), left, right.
- Edges are directional or bidirectional; default edges are bidirectional.

### Core interactions

- Click a node to select it and open the inspector.
- Drag nodes to reposition.
- Drag from a port to another node to create an edge.
- Right-click on the canvas to open the "Add Agent" menu.

### Keyboard shortcuts (current)

- `Esc`: deselect
- `Delete` / `Backspace` / `Shift+Q`: delete selected node or edge
- `f`: center stage (toggle focus on selected node)
- `Shift+D`: duplicate selected node
- `i` / `o`: cycle input/output neighbors of selected node

## Inspector

The inspector shows node state, messages, tool activity, console output, and artifacts. It also allows you to send chat messages and toggle run/global modes.

## Notes

- There is no multi-select in v0.
- The UI does not enforce join gates or trigger modes.
