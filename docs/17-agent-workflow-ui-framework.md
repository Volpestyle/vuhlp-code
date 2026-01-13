# Agent Workflow UI Framework Spec

## 1. Objective
To establish a flexible, extensible framework for visualizing, configuring, and executing complex multi-agent workflows. The system represents agents as "windows" (nodes) in a graph, connected by directed edges representing data flow, control handoffs, or feedback loops.

## 2. Core Concepts

### 2.1 The Agent Node ("Window")
An Agent Node is a functional unit wrapping an underlying provider (Claude, Codex, Gemini) or a deterministic tool.
*   **Visual Representation:** A window with a header (identity/status), a content body (logs/chat/config), and specific **Ports** on the perimeter.
*   **Ports:** Explicit connection points.
    *   **Input Port (Top):** Receives context, prompts, or structured data.
    *   **Output Port (Bottom):** Emits results, artifacts, or control signals.
    *   *Future:* Side ports for auxiliary data (e.g., "Resources", "Logs").

### 2.2 The Connection ("Edge")
A directed link between an Output Port of one node and an Input Port of another (or the same) node.
*   **Semantics:** Represents a "Handoff". When Node A finishes, its output is marshaled and sent to Node B.
*   **Types:**
    *   **Linear:** A -> B (Standard handoff).
    *   **Loop:** A -> A (Self-correction/Refinement).
    *   **Feedback:** B -> A (Upstream feedback loop).
    *   **Branch:** A -> [B, C] (Parallel execution or conditional routing).

### 2.3 The Graph ("Workflow")
The collection of Nodes and Edges that defines the orchestration logic. This graph is **executable**.

## 3. UI Component Architecture

The framework consists of React components that manage the visual state and interaction logic, layered over a graph engine (Cytoscape.js).

### 3.1 Component Hierarchy
```
GraphPane (Canvas)
├── Cytoscape Layer (Layout & Edges)
├── Node Layer (HTML Overlays)
│   ├── NodeWindow (The container)
│   │   ├── NodeHeader (Drag handle, Status)
│   │   ├── Port (Input - Top)
│   │   ├── Content (Dynamic based on Agent Type)
│   │   └── Port (Output - Bottom)
├── Interaction Layer (SVG Overlay)
│   └── DragEdge (Temporary line during connection creation)
```

### 3.2 Port Component (`Port.tsx`)
*   **Props:** `type: 'input' | 'output'`, `nodeId: string`, `onConnectStart`, `onConnectEnd`.
*   **Visuals:** A distinct circle on the window border.
*   **Interaction:**
    *   `mousedown`: Initiates connection drag mode.
    *   `mouseup`: Completes a connection if a valid source exists in the drag state.
    *   **Hover State:** Highlights compatible ports during dragging.

### 3.3 Connection Logic
1.  **Initiation:** User clicks/drags from an **Output Port**.
2.  **Dragging:** A temporary SVG line follows the mouse cursor from the source port.
3.  **Targeting:** Valid **Input Ports** highlight when hovered.
    *   *Validation:* Prevent Input->Input or Output->Output connections.
    *   *Cycles:* Allowed (this is a key feature for loops).
4.  **Completion:** Releasing on a valid target creates a new Edge in the model.

## 4. Advanced Workflow Patterns

The framework supports creating "Custom Workflows" by assembling primitive agents.

### 4.1 Self-Correction Loop (The "Refine" Pattern)
*   **Configuration:** Agent A is configured to produce code.
*   **Connection:** Agent A Output -> Agent A Input.
*   **Logic:**
    1.  Agent A runs.
    2.  Output is analyzed (e.g., by a Verifier shim or internal check).
    3.  If unsatisfactory, Output is fed back into Input with "Critique" context.
    4.  Agent A runs again (Iteration 2).

### 4.2 Planner-Executor-Reviewer Loop
*   **Nodes:** Planner (P), Executor (E), Reviewer (R).
*   **Connections:**
    *   P -> E (Plan handoff)
    *   E -> R (Result handoff)
    *   R -> P (Feedback/Status)
*   **Flow:**
    1.  Planner creates task list.
    2.  Executor performs task 1.
    3.  Reviewer checks task 1.
    4.  If Fail: Reviewer sends error to Planner -> Planner adjusts.
    5.  If Pass: Reviewer sends success to Planner -> Planner sends task 2.

### 4.3 Parallel Fan-Out/Fan-In
*   **Nodes:** Manager (M), Worker 1 (W1), Worker 2 (W2), Summarizer (S).
*   **Connections:**
    *   M -> W1
    *   M -> W2
    *   W1 -> S
    *   W2 -> S
*   **Logic:** M splits task. W1/W2 run in parallel. S waits for *both* (Merge/Gate logic) before running.

## 5. Data Model & Serialization

The graph is serialized to JSON for storage and execution.

```json
{
  "version": "1.0",
  "id": "workflow-uuid",
  "nodes": {
    "node-1": {
      "type": "agent",
      "provider": "claude",
      "config": { "systemPrompt": "You are a code reviewer." },
      "ui": { "x": 100, "y": 100 }
    },
    "node-2": {
      "type": "agent",
      "provider": "codex",
      "config": { "systemPrompt": "Fix the code." },
      "ui": { "x": 100, "y": 400 }
    }
  },
  "edges": [
    {
      "source": "node-1",
      "target": "node-2",
      "type": "handoff",
      "condition": "status == 'failed'" // Conditional routing
    },
    {
      "source": "node-2",
      "target": "node-1",
      "type": "report"
    }
  ]
}
```

## 6. Implementation Roadmap

### Phase 1: Visual Wiring (UI Only)
*   [x] Update `Port` styling to align perfectly with edge endpoints.
*   [x] Implement `DragEdge` interaction in `GraphPane`.
*   [x] specific `onConnect` callback to update Graph state.

### Phase 2: Configuration & Node Types
*   [x] Basic "Add Agent" button (POC).
*   [ ] Create a "Toolbox" of available Agent templates.
*   [ ] Drag-and-drop Nodes from Toolbox to Canvas.
*   [ ] Node Configuration Panel (Inspector) to edit node prompts/settings.

### Phase 3: Runtime Execution
*   [x] Backend engine to traverse the graph.
*   [x] Backend API to create nodes and edges.
*   [ ] Handling of "cycles" (loop detection and termination conditions).
*   [ ] State management for parallel branches.
