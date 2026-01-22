# Vuhlp Agent Platform

> **Local-first, graph-based orchestration for autonomous AI agents.**

Vuhlp is a monorepo platform designed to orchestrate multiple coding agents (OpenAI, Anthropic, Google, etc.) in user-defined workflows. Workflows are graphs: nodes are autonomous agents and edges are explicit handoffs.

## Core Philosophy

- **Graph-First**: Workflows are directed graphs. Nodes and edges define data flow.
- **Local-First Privacy**: Runs, logs, and artifacts live on your machine.
- **Agent Autonomy**: Nodes can work independently; an orchestrator node can coordinate.
- **Full Observability**: Prompts, tool calls, outputs, and artifacts are logged.
- **Loop Safety**: Stall detection pauses runs instead of hard-capping them.

## Quickstart

### Prerequisites
- **Node.js**: 25+
- **pnpm**: 9.x (see `package.json`)
- Provider CLIs (optional but recommended): Claude Code, Codex, Gemini

### Install

```sh
pnpm install
```

### Run the daemon

```sh
pnpm dev
```

Daemon defaults:
- HTTP: http://localhost:4000
- WebSocket: ws://localhost:4000/ws

### Run the UI (dev)

```sh
pnpm --filter @vuhlp/ui dev
```

Open the UI at http://localhost:5173

## Project Structure

- **`packages/daemon`**: Runtime (Express + WS) that manages runs, nodes, and events.
- **`packages/ui`**: React UI (graph editor + inspector).
- **`packages/contracts`**: Shared TypeScript types and JSON schemas.
- **`packages/shared`**: Shared utilities (API client, logging, UI helpers).
- **`packages/providers`**: Provider adapters and local CLI forks.
- **`packages/mobile`**: Mobile companion app (Expo / React Native).

## CLI Patches for Orchestration

To support true multi-turn streaming, Vuhlp uses local forks:
- **Codex**: `packages/providers/codex` (submodule) with `codex vuhlp` JSONL stdin/stdout.
- **Gemini**: `packages/providers/gemini-cli` (submodule) with stream-json stdin.

See `docs/09-cli-patches.md` for details and maintenance notes.

## Documentation

The `docs/` folder is the canonical spec for the current implementation. Start here:

1. `docs/01-product-spec.md`
2. `docs/05-graph-rules-and-scheduling.md`
3. `docs/12-api.md`
