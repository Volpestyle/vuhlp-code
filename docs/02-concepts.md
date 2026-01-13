# Concepts

## Session

A **Session** represents your active workspace and the state of your orchestration graph. Unlike a linear pipeline, a session allows you to build, modify, and interact with a dynamic graph of agents in real-time.

## Node

A **Node** is the fundamental unit of work in the graph. Nodes are versatile containers that host an agent or tool interface.

Key properties:
- **Provider**: The underlying AI model or CLI tool (e.g., Claude, Codex, Mock).
- **Context**: The conversation history and current working state.
- **Configuration**: Roles, instructions, and tool access.

By default, a Node acts as a standard CLI terminal for its provider.

## Role

A **Role** is a template applied to a Node to specialize its behavior. It defines:
- **System Instructions**: "You are a senior architect..."
- **Capabilities**: Access to specific tools (e.g., file writing, subagent spawning).
- **Loop Behavior**: How the agent behaves in 'Auto' mode.

Common Roles:
- **Orchestrator**: Oversees a task, spawns subagents, reconciles disparate changes, and manages high-risk operations.
- **Planner**: Analyses requests, identifies gaps, and writes to the `/docs/` folder.
- **Coder**: Focuses on implementation details and code generation.
- **Verifier**: Runs commands (tests, lint) and critiques outputs.

## Modes

### Node Mode (Per-Node)
- **Interactive**: The node waits for user input. You chat with the specific agent instance directly.
- **Auto**: The node operates in a loop.
  - If connected: It processes inputs from upstream nodes automatically.
  - If standalone: It continuously works on its assigned goal (e.g., "Fix this bug") until verified.

### Global Workflow Mode (System-wide)
- **Planning Mode**:
  - Focus: Investigation, design, and documentation.
  - Constraints: Agents write ONLY to `/docs/`. Codebase is treated as read-only.
  - Behavior: Agents ask clarifying questions and identify risks.
- **Implementation Mode**:
  - Focus: Execution and code application.
  - Behavior: Agents propose and apply changes.
  - Safety: Subagents usually apply low-risk scaffolding changes. High-risk/complex changes are routed to the Orchestrator for reconciliation and application.

## Edge

An **Edge** defines the flow of information between nodes.

- **Connection**: `Node A (Output) -> Node B (Input)`
- **Data Flow**: When Node A produces an output (e.g., a code block, a plan, or a message), it is forwarded to Node B.
- This allows for **Chains** (Start -> Architect -> Coder) and **Loops** (Coder -> Verifier -> Coder).

## Artifact

An **Artifact** is a persistent object generated during a session:
- Reusable metadata (plans, reports).
- File patches/diffs.
- Execution logs.
- Verification results.

## Provider

A **Provider** connects the system to an external agent runner:
- `mock`: Internal test provider.
- `codex-cli`: Interface to OpenAI Codex.
- `claude-cli`: Interface to Anthropic Claude.
- `gemini-cli`: Interface to Google Gemini.
