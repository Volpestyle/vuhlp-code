# Vuhlp Agent Platform

> **Local-first, graph-based orchestration for autonomous AI agents.**

Vuhlp is a monorepo platform designed to orchestrate multiple coding agents (like OpenAI's models, Anthropic's Claude, etc.) in complex, user-defined workflows. Unlike rigid pipelines, Vuhlp uses a graph-based approach where "nodes" are autonomous agents and "edges" represent data handoffs.

## Core Philosophy

- **Graph-First**: Workflows are directed graphs. You connect valid "ports" (inputs/outputs) between agents to define how data flows.
- **Local-First Privacy**: All runs, event logs, and artifacts live explicitly on your machine. No cloud storage of your code or prompts.
- **Agent Autonomy**: Agents can work independently, but a central "Orchestrator" node can supervise, delegate, and review work.
- **Full Observability**: Every tool call, shell command, and reasoning step is logged. The UI provides a "Zero-Truncation" generic view of all events.
- **Loop Safety**: The system prefers visibility over hard limits, detecting stalls (repeated outputs) to prevent infinite loops without killing productive long-running tasks.

## Quickstart

### Prerequisites
- **Node.js**: 25
- **pnpm**: Version 9.x (see `package.json`)

### Installation

```sh
pnpm install
```

### Running the Platform
Start the development daemon and the UI:

```sh
pnpm dev
```
This launches the local orchestrator daemon and serves the web UI (usually at `http://localhost:3000` or similar).

### Other Commands

```sh
pnpm build   # Build all packages
pnpm lint    # Lint codebase
```

## Project Structure

This is a monorepo managed by pnpm workspaces.

- **`packages/ui`**: The React-based frontend (Graph Builder, Inspector, Chat).
- **`packages/daemon`**: The Node.js backend service (Express/Socket.io) that manages agent processes and state.
- **`packages/contracts`**: Shared TypeScript types and Zod schemas used by both frontend and backend.
- **`packages/providers`**: Adapters for different LLM/Agent providers (e.g., standard CLI wrappers).
- **`contracts/`**: Source-of-truth logic for graph rules and data shapes.

## Documentation

The `docs/` folder contains the canonical specifications for the product. If you are developing on Vuhlp, **start here**:

1.  [Product Spec](docs/01-product-spec.md) - High-level vision and requirements.
2.  [Graph Rules](docs/05-graph-rules-and-scheduling.md) - How nodes and edges interact.
3.  [Orchestration Modes](docs/06-orchestration-modes-and-loop-safety.md) - Auto vs Interactive loops.

> **Note**: This documentation is the "source of truth". If the implementation diverges from the docs, the implementation should be fixed to match the docs.
