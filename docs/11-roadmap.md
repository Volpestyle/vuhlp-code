# Roadmap

## v0 (Current)

### Graph-First Orchestration
- **Flexible Graph Engine**: Build and connect nodes dynamically in the UI
- **No Fixed Pipeline**: Sessions start with a single node; users build workflows visually
- **Roles as Templates**: Orchestrator, Coder, Planner, Verifier are presets, not constraints
- **Custom Instructions**: Every node can have user-defined system prompts and capabilities

### Hybrid Autonomy
- **Per-node Auto/Interactive**: Each node independently loops or waits for user input
- **Global Auto/Interactive Toggle**: Control all nodes at once
- **Auto Mode Looping**: Nodes re-execute their prompt until goals are met

### Global Workflow Modes
- **Planning Mode**: Agents research, ask questions, write to /docs/ only
- **Implementation Mode**: Agents apply code changes with orchestrator oversight

### Provider Support
- **Claude CLI**: Full streaming and session continuity
- **Codex CLI**: Full streaming and session continuity
- **Gemini CLI**: Full streaming and session continuity
- **Mock Provider**: For testing and demos

### Local-First Architecture
- Daemon + Web UI
- Event-sourced state
- Real-time WebSocket updates

## v1 (Fast Follow)

### Workflow Templates
- **Save/Load Patterns**: Capture effective workflows for reuse
- **Template Library**: Pre-built patterns (Code Review Loop, Feature Pipeline, etc.)
- **Shareable Configurations**: Export/import workflow definitions

### Enhanced Graph Features
- **Merge Automation**: Smart conflict resolution for parallel agents
- **Consensus Strategies**: Run multiple agents on same task, pick best result
- **Dependency Gates**: Fine-grained control over execution order

### UI Improvements
- **Timeline View**: Visualize execution over time
- **Diff Viewer**: Inline syntax highlighting for patches
- **Node Toolbox**: Drag-and-drop agent templates

## v2 (Collaborative)

- **Remote Runners**: Distributed agent execution
- **Team Mode**: Shared dashboards and workflows
- **Integrations**: GitHub, Linear, Slack

## v3 (Advanced)

- **Time-travel Debugging**: Replay and fork execution states
- **Skill Libraries**: Shareable agent capabilities
- **Multi-tenant**: Enterprise deployment options
