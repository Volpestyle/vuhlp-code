# Architecture

v0 is composed of three main layers:

1. **Daemon (control plane)**: `packages/daemon` manages runs, scheduling, and event logs.
2. **Provider adapters (execution plane)**: `packages/providers` spawn CLIs or call APIs.
3. **UI (observability + control)**: `packages/ui` renders the graph and inspector.

## Core components

### Daemon (`packages/daemon/src`)

- **Runtime**: top-level coordinator for runs, nodes, edges, and artifacts.
- **RunStore**: in-memory run state with persistence to disk.
- **EventBus**: emits events to WS subscribers and persists to JSONL.
- **Scheduler**: runs queued nodes, handles auto-reprompt for the orchestrator, and stall detection.
- **CliRunner**: builds prompts, runs provider turns, parses tool calls, and emits events.
- **PromptBuilder**: assembles system + role + mode + task prompt blocks.
- **ProviderResolver**: resolves provider config from env and applies CLI defaults.
- **ArtifactStore / EventLog**: write artifacts and append event logs under `dataDir`.

### Provider adapters (`packages/providers/src`)

- **CliProviderAdapter**: spawns CLI processes and normalizes stream-json/jsonl output.
- **ApiProviderAdapter**: calls provider APIs when `VUHLP_<PROVIDER>_TRANSPORT=api`.

Local forks live in:
- `packages/providers/codex` (Codex fork with `codex vuhlp`)
- `packages/providers/gemini-cli` (Gemini fork with stream-json stdin)

### UI (`packages/ui`)

- Graph canvas + inspector built with Cytoscape.
- Connects to daemon via REST (`/api/*`) and WS (`/ws`).

## Storage layout

```
<dataDir>/
  runs/<runId>/
    state.json
    events.jsonl
    artifacts/
```

## Monorepo structure

```
vuhlp-code/
├── packages/
│   ├── daemon/
│   ├── providers/
│   ├── ui/
│   ├── contracts/
│   ├── shared/
│   └── mobile/
└── docs/
```
