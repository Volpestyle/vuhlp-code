# Roadmap

## v0 (this zip)

- Local daemon + static web UI
- Canonical event model and run state
- Simple investigation → planning → implement → verify loop
- Provider adapters:
  - mock (works out of the box)
  - codex-cli / claude-cli / gemini-cli (best-effort parsing)
- Workspace manager (shared + optional worktree/copy)
- Deterministic verification commands

## v1 (near-term)

### Orchestration
- Multi-orchestrator nesting (subgraphs per domain: frontend/backend/infra)
- Step-level dependency scheduling (true DAG execution)
- “Race” and “Consensus” strategies:
  - race implementers
  - consensus planning across providers
- Merge automation:
  - merge worktrees
  - conflict-resolution nodes

### Provider integration
- Richer parsing of Codex/Claude/Gemini streaming events
- Support provider “resume session” features more explicitly
- Tool-permission routing to UI:
  - Claude `--permission-prompt-tool`
  - Codex approvals
  - Gemini approval modes

### UI
- Timeline view (spans)
- Diff viewer inline
- Live command output tails
- Filters and search across runs/nodes

### DevEx
- Run export/import (bundle of state + artifacts)
- Run templates (prompt + config presets)

## v2 (mid-term)

### Distributed + team mode
- Remote runners (LAN / cloud)
- Shared run dashboard, role-based access
- Integrations:
  - GitHub PR creation/update
  - Linear/Jira issue sync
  - Slack updates

### Reliability
- Deterministic replay
- Crash recovery and resumable runs
- Stronger invariants for event sourcing

### Policy + compliance
- Policy packs:
  - allowed commands
  - path allowlists
  - network restrictions
- Audit views and redaction

## v3 (stretch)

- “Orchestration IDE” features:
  - graph editing (manual rewiring)
  - time-travel debugging
  - agent skill libraries
