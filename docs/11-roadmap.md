# Roadmap

## v0 (Current)

### Graph-First Orchestration
- Dynamic graph editing (nodes + edges)
- Explicit handoffs via edges
- Role templates per node
- Custom system prompts and per-node capabilities

### Autonomy + Safety
- AUTO vs INTERACTIVE run modes
- Orchestrator auto-reprompt in AUTO
- Stall detection with `run.stalled` evidence

### Provider Support
- Claude CLI (stream-json)
- Codex CLI (local fork, jsonl)
- Gemini CLI (local fork, stream-json)
- API transport for all providers

### Local-First Architecture
- Daemon + Web UI
- Mobile companion app (Expo)
- JSONL event log + on-disk artifacts
- Real-time WebSocket updates

## v1 (Fast Follow)

- Workflow templates (save/load graph patterns)
- Timeline view + richer diff viewer
- Enhanced scheduling constraints (join gates, trigger modes)

## v2 (Collaborative)

- Remote runners
- Team mode
- Integrations (GitHub, Linear, Slack)

## v3 (Advanced)

- Time-travel debugging
- Skill libraries
- Enterprise deployment options
