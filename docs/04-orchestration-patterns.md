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
   - **If Fail**: Output (Error Logs) is sent back to the Coder.
3. **Coder Node (Auto)**: Receives the error logs, analyzes the failure, patches the code, and outputs the result back to the Verifier.

## 4. The Orchestrator (Supervisor)

For high-complexity tasks, use a Supervisor pattern.

**Structure**:
- **Hub**: Orchestrator Node.
- **Spokes**: Multiple specialized Maker/Researcher nodes.

**Workflow**:
1. **Delegation**: The Orchestrator breaks down the user prompt and prompts specific sub-nodes (e.g., "FrontendAgent", "BackendAgent") with sub-tasks.
2. **Parallel Execution**: Sub-nodes work in parallel (in Auto mode).
3. **Reconciliation**: Sub-nodes report back their findings or patches. The Orchestrator reviews the combined result, resolves conflicts, and finalizes the work.

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
