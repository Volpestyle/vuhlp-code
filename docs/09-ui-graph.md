# UI and Graph Builder

The UI is not just a viewer; it is a full **Graph Builder** where you construct and manage your agent workforce.

## Graph Canvas

The central area is an infinite canvas for visual programming.

### Building Actions
- **Add Node**: Click the floating "+" button to spawn a new, generic Node.
- **Connect**: click and drag from a node's **Output Port** (Right) to another node's **Input Port** (Left) to create a data flow connection.
- **Select**: Click nodes to inspect them. Shift-click to select multiple.
- **Arrange**: Drag nodes to organize your layout.

### Visual Semantics
- **Solid Line**: Direct data flow / handoff.
- **Pulsing Node**: Currently executing (Thinking or Running Tool).
- **Amber Border**: Waiting for User Input (Interactive Mode).

## Node Window (Inspector)

When you select a node, its detailed Inspector panel opens. This is where you configure and drive the specific agent.

### 1. Chat & Interaction
The main view is a chat interface.
- **Interactive Mode**: It works like a standard chat. You type, it replies.
- **Auto Mode**: You see a stream of self-prompted actions and loop iterations.

### 2. Configuration Tab
Customize the node's identity:
- **Role**: Select a preset (Orchestrator, Coder) or "Custom".
- **System Instructions**: Edit the exact prompt the agent receives.
- **Provider**: Switch the underlying model (e.g., Swap Claude for Codex).
- **Mode Toggle**: Switch between **Auto** and **Interactive**.

### 3. Inputs & Outputs
- See exactly what data arrived from upstream nodes.
- View the artifacts (files, reports) this node has produced.

## Global Controls

- **Planning / Implementation Switch**: The master toggle for the workspace context.
- **Start / Stop**: Global controls to pause all "Auto" nodes or resume them.
