# Orchestration Patterns

v0 moves away from a fixed, hard-coded orchestration loop. Instead, it provides a flexible graph architecture where you can compose agents to create custom workflows.

## 1. The Single Node (Default)

Every session starts with the potential for simplicity.

- **Structure**: One Node.
- **Workflow**: 1-on-1 Chat.
- **Usage**: Use this for quick queries, debugging, or simple tasks. It behaves exactly like a standard CLI session with Claude, Codex, or Gemini.

## 2. The Chain (Pipeline)

Connect nodes linearly to pass context and outputs forward.

**Example**: `Architect -> Coder -> DocWriter`

1. **Architect Node**: You prompt it to design a feature. Its output is the design spec.
2. **Coder Node (Auto)**: Receives the spec. It implements the code and outputs the file lists/diffs.
3. **DocWriter Node (Auto)**: Receives the code changes. It updates the documentation to match.

## 3. The Loop (Feedback Cycle)

Create cycles in the graph to enable self-healing and iteration.

**Example**: `Coder <-> Verifier`

1. **Coder Node**: Writes the initial implementation.
2. **Verifier Node**: Runs the test suite.
   - **If Pass**: Flow stops or continues downstream.
   - **If Fail**: Output (Error Logs) is sent back to the Coder via a "Tick" payload.
3. **Coder Node (Auto)**: 
   - Receives the error logs "tick". 
   - Does *not* re-plan from scratch; instead, it analyzes the specific failure diff and patches the code.
   - Outputs the result back to the Verifier.

**Safety**: Loops are protected by:
- **Max Iterations**: Preventing infinite cycles.
- **Stall Detection**: Halting if 3 consecutive failures produce identical verification logs.

## 4. Fan-In and Synchronization (Orchestrator-Managed)

When multiple agents work in parallel, the Orchestrator manages the synchronization directly.

**Example**: `(Frontend, Backend) -> Integration`

1. **Orchestrator**: Spawns `Frontend Task` and `Backend Task`.
2. **Parallel Work**: Both agents work independently.
3. **Completion**:
   - `Frontend Task` reports "Done".
   - `Backend Task` reports "Done".
4. **Orchestrator Decision**:
   - The Orchestrator sees both are complete.
   - It then decides to spawn `IntegrationVerifier` or merge the code itself.

There is no "JoinGate" node. The join logic resides in the Orchestrator's intelligence, which handles the synchronization.

## 5. The Docs-First Lifecycle

To prevent documentation drift, the graph enforces a documentation contract.

**Example**: `Planner -> DocContract -> Implementer -> DocReviewer`

1. **Planner**: Analyzes the request and drafts a "Docs Contract" (empty files or updated specs in `/docs/`).
2. **DocContract Gate**:
   - A logic check that prevents the Implementer from starting until the contract exists.
3. **Implementer**: writes code to fulfill the contract.
4. **DocReviewer (Auto)**:
   - Triggered after Implementation.
   - Scans the new code and the old docs.
   - Generates a "Docs Sync" patch to ensure they match.
   - Fails the pipeline if a major contradiction is found.

## 6. The Orchestrator (Supervisor)

For high-complexity tasks, use a Supervisor pattern to manage the above patterns.

**Structure**:
- **Hub**: Orchestrator Node.
- **Spokes**: Multiple specialized Maker/Researcher nodes.

**Workflow**:
1. **Delegation**: The Orchestrator breaks down the user prompt and spawns sub-nodes using the `spawn_node` command.
2. **Parallel Execution**: Sub-nodes work in parallel (in Auto mode).
3. **Reconciliation**: Sub-nodes report back their findings or patches. The Orchestrator reviews the combined result, resolves conflicts (functioning as a manual JoinGate), and finalizes the work.

**Example - Spawning Parallel Workers**:
```json
{
  "command": "spawn_node",
  "args": {
    "role": "implementer",
    "label": "Frontend Builder",
    "instructions": "Build the React components for the dashboard..."
  }
}
```

```json
{
  "command": "spawn_node",
  "args": {
    "role": "implementer",
    "label": "Backend Builder",
    "instructions": "Implement the API endpoints for dashboard data..."
  }
}
```

> See [prompts.md](./prompts.md#4-graph-commands-reference) for the full `spawn_node` command specification.

## Impact of Global Modes

The Global **Planning/Implementation** toggle drastically changes how these patterns execute.

### In Planning Mode
- **Goal**: producing artifacts in `/docs/`.
- **Behavior**:
  - **Orchestrator**: Asks clarifying questions. Validates requirements.
  - **Subagents**: strictly read-only on code. They scan the repo, find gaps, and draft plans.
  - **Loops**: Verifiers check for "Plan Completeness" rather than "Test Pass".

### In Implementation Mode
- **Goal**: shipping code.
- **Behavior**:
  - **Orchestrator**: Manages the "Merge". It decides when to apply changes.
  - **Subagents**:
    - **Scaffolding**: Can be allowed to write new files directly.
    - **Refactoring**: Must submit patches to the Orchestrator for review (to avoid race conditions).
  - **Loops**: Verifiers run actual builds and tests.
