# vuhlp code documentation

This folder contains the **product + technical spec** plus implementation notes for v0.

## Table of contents

### Getting Started
- [01. Quickstart](./01-quickstart.md) — Install, configure, and run
- [02. Concepts](./02-concepts.md) — Core vocabulary and mental model

### Architecture
- [03. Architecture](./03-architecture.md) — System layers and components
- [04. Orchestration Patterns](./04-orchestration-patterns.md) — Chains, loops, fan-out, supervisors
- [05. Provider Adapters](./05-provider-adapters.md) — Claude, Codex, Gemini CLI integration

### Configuration & Operations
- [06. Authentication](./06-auth.md)
- [07. Workspaces and Patches](./07-workspaces.md) — Shared, worktree, copy modes
- [08. Verification](./08-verification.md) — Build/test/lint verification
- [09. UI and Graph](./09-ui-graph.md) — Graph canvas and node windows
- [10. Configuration](./10-config.md) — Full config schema reference

### API & Integration
- [11. Roadmap (v1/v2)](./11-roadmap.md)
- [12. HTTP + WS API](./12-api.md) — REST endpoints and WebSocket events
- [13. Security + Privacy](./13-security.md)
- [14. Design Decisions](./14-decisions.md)
- [15. Agents SDK Integration](./15-agents-sdk-integration.md)

### Advanced Topics
- [16. Custom Interface Mode](./16-custom-interface-mode.md)
- [17. Agent Workflow UI Framework Spec](./17-agent-workflow-ui-framework.md)
- [18. Execution Semantics](./18-execution-semantics.md) — Determinism and safety contracts
- [20. Loop Safety and Non-Progress Detection](./20-loop-safety-and-nonprogress.md)
- [21. Context Packs](./21-context-packs.md) — Prompt construction strategy
- [22. Docs Lifecycle (docs-first autonomy)](./22-docs-lifecycle.md)
- [23. Failure Modes and Recovery](./23-failure-modes-and-recovery.md)
- [24. CLI Equivalence (terminal-first mode)](./24-cli-equivalence.md)
- [25. Debugging and Observability](./25-debugging-and-observability.md) — Logs, events, troubleshooting

### Agent Prompts & Commands
- [System Prompts](./prompts.md) — Orchestrator, subagent prompts, and `spawn_node` command reference

## Schemas and Examples

- JSON schemas: `docs/schemas/`
- Example config and prompts: `docs/examples/`

## Implementation Status

- [Implementation Alignment](./implementation_alignment.md) — Feature status (v0/v1/planned)
- [Implementation Audit Report](./implementation_audit_report.md) — Code-to-docs alignment audit
