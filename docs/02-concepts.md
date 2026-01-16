# Concepts

## Session

A **Session** represents your active workspace and the state of your orchestration graph. Unlike a linear pipeline, a session allows you to build, modify, and interact with a dynamic graph of agents in real-time.

## Node

A **Node** is the fundamental unit of work in the graph. Nodes are versatile containers that host an agent or tool interface.

Key properties:
- **Provider**: The underlying AI model or CLI tool (e.g., Claude, Codex, Mock).
- **Context**: The conversation history and current working state.
- **Configuration**: Roles, instructions, and tool access.
- **Trigger Mode**: Defines when the node executes:
  - `On Any Input`: Fires immediately when any upstream edge delivers a payload (default).
  - `On All Inputs` (Join): Waits for a payload from *every* connected upstream edge before firing (used for synchronization).
  - `Manual`: Only fires on explicit user trigger.
  - `Scheduled`: Fires on a cron/timer.

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
- **DocReviewer**: A specialized verifier that checks code-to-docs consistency.

## Modes

### Node Mode (Per-Node)
- **Interactive**: The node waits for user input. You chat with the specific agent instance directly.
- **Auto**: The node operates in a continuous loop.
  - **Tick-Based Continuation**: In each iteration, the node receives a "tick" payload containing new events, verification results, or diff summaries. It does *not* reset its context or re-run the initial prompt from scratch.
  - **Termination**: The node decides to stop when it produces a "Done" signal or satisfies specific acceptance criteria.

### Global Workflow Mode (System-wide)
- **Planning Mode**:
  - Focus: Investigation, design, and documentation.
  - Constraints: Agents write ONLY to `/docs/`. Codebase is treated as read-only.
  - Behavior: Agents ask clarifying questions and identify risks.
- **Implementation Mode**:
  - Focus: Execution and code application.
  - Behavior: Agents propose and apply changes.
  - Safety: Subagents usually apply low-risk scaffolding changes. High-risk/complex changes are routed to the Orchestrator for reconciliation and application.

## Edge & Dataflow

An **Edge** defines the flow of information between nodes.

### Structure
Connections are **Bidirectional** by default.
`Node A <-> Node B`

This enables natural conversation flows where agents can reply to each other without needing multiple connections. You can still enforce directional flows (`Node A -> Node B`) if needed.

### Typed Payloads
Edges do not just forward raw text. They carry structured **Envelopes**:
```json
{
  "kind": "handoff",
  "fromNodeId": "src-123",
  "toNodeId": "dst-456",
  "payload": {
    "message": "Here is the implemented plan.",
    "structured": { "status": "review_needed", "confidence": 0.9 },
    "artifacts": [
      { "type": "diff", "ref": "file:///..." },
      { "type": "report", "ref": "file:///..." }
    ]
  }
}
```

### Delivery Semantics
Edges define how payloads are delivered to the downstream node:
- **Queue**: All payloads are queued and processed one by one (default).
- **Latest**: Only the most recent payload is kept; older unprocssed payloads are dropped (useful for status updates).
- **Debounce**: Payloads are held until a quiet period occurs (useful for reducing noise).

## Execution Semantics & Safety

To prevent infinite loops and thrashing, the runtime enforces strict safety controls:

### Cycle Termination
- **Max Iterations**: Hard limit on how many times a loop can run.
- **Stall Detection**: The scheduler halts a loop if "progress" signals stop (e.g., no file changes, same error log returned 3 times).

### Budgets
Nodes and Subgraphs are constrained by:
- **Time Budget**: Max runtime duration.
- **Cost/Token Budget**: Limits on API usage to prevent runaway bills.

### Concurrency
- **Max In-Flight**: Limits how many nodes can execute effectively in parallel to prevent resource exhaustion.
- **File Locks**: Advisory locks on files/directories to prevent race conditions between parallel agents.

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
