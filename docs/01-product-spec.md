# Product Spec

## Purpose
Build a local-first, graph-based orchestration harness for multiple coding agents. The system should make agent autonomy safe, visible, and controllable without forcing a fixed pipeline. Users can build custom workflows by wiring agent nodes together, while an orchestrator can supervise and coordinate complex tasks when needed.

## Product vision
- Customizable orchestration: Users build their own workflows by connecting agent nodes in a graph.
- Agent autonomy: Each node acts as an autonomous CLI agent that can exchange handoffs with peers.
- Orchestrator as supervisor: The orchestrator can act as the user's delegate to command many agents, but it should not be required for simple tasks.
- Visibility over limits: We prioritize full visibility and stall detection over hard caps on run length.
- Local-first privacy: All runs, events, and artifacts live on the user's machine.

## Goals
- Provide a flexible orchestration layer that works with existing CLI agents (Codex, Claude Code, Gemini, others).
- Enable fast, safe iteration by letting agents hand off work and collaborate through structured payloads.
- Maintain a complete, readable event log of everything the system did and why.
- Support both skip-permissions and non-skip-permissions modes for all providers, with skip-permissions as the default.
- Allow agents to apply changes directly, while still giving the orchestrator and user the ability to review.

## Non-goals
- Cloud hosting, multi-tenant collaboration, or remote runners.
- Automated merge/conflict resolution. Agents must be prompted to edit in harmony; orchestrator reviews outcomes.
- Hidden agent behavior. Every action should be observable.

## Future enhancements (not required now)
- Remote control from a native iPhone app.

## Core concepts (product-level)
- Run: A single orchestration session with a graph of nodes and edges.
- Node: A single agent session (CLI process or wrapper) with its own context and tool access.
- Edge: A data link between nodes that agents can use when sending handoffs.
- Orchestrator: A supervisor node that can delegate, review, and reconcile.
- Global workflow mode: Planning vs Implementation. Planning is docs + research only. Implementation allows code edits.
- Orchestration mode: Auto vs Interactive. Auto can re-prompt the orchestrator to achieve the goal. Interactive pauses orchestration for user input.

## System overview

ASCII overview:

```
User
  |
  v
UI (graph + inspector) <----> Daemon (scheduler + event log)
  |                                  |
  |                                  v
  |                              Providers (CLI agents)
  |                                  |
  v                                  v
Workspace / Repo <---------------- Event + Artifact Store
```

## Experience principles
- Graph-first: The graph is the workflow. There is no fixed pipeline.
- Autonomy with constraints: Nodes can work independently but must follow role-based permissions.
- Consent and review: Risky actions can require approvals; orchestrator can always review.
- Determinism where possible: Inputs, outputs, and handoffs are logged for replay.
- Operational clarity: The UI should show what each agent is doing, what it consumed, and what it produced.

## Functional requirements (high-level)
1) Multi-provider orchestration
- Support multiple CLI providers with session continuity.
- Unified event model for messages, tools, diffs, and approvals.

2) Graph workflow builder
- Create nodes, connect edges, and run workflows.
- Inputs are auto-consumed when delivered.

3) Orchestration modes
- Auto: Orchestrator can self-loop and pursue the run goal.
- Interactive: Orchestrator waits for user prompts; other nodes still process incoming inputs.

4) Planning vs Implementation
- Planning: read-only repo access; writes limited to docs (configurable).
- Implementation: code edits allowed; docs can also be updated.

5) Loop safety without hard caps
- Detect stalls and useless loops via repeated outputs, unchanged diffs, or no new artifacts.
- On stall, pause orchestration and notify the user with evidence.

6) Approval handling
- Support skip-permissions (default) and non-skip-permissions modes for each provider.
- Forward provider approval requests to the UI and allow user responses.

7) Complete observability
- Event log for every run, including prompts, tool usage, and outputs.
- Artifacts for diffs, logs, and transcripts.
- Ability to reset a node's context quickly (clear session and start fresh).

## Success criteria
- A developer can rebuild the system from these docs and achieve parity or better behavior.
- A user can run a complex task with multiple agents, see everything, and intervene safely.
- The system prevents useless loops without hard-stopping long productive sessions.

## Open questions (track here as needed)
- None. Update as product decisions evolve.
