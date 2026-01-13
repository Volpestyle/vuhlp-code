# Quickstart

## 1) Install dependencies

```bash
pnpm install
```

## 2) Start the daemon + UI

```bash
pnpm dev
```

This starts:

- HTTP server: `http://localhost:4317`
- WebSocket: `ws://localhost:4317/ws`

## 3) Start a Session

Open the UI. You start with a fresh workspace where you can build your orchestration flow.
Unlike fixed pipelines, you have full control over the graph structure.

## 4) Add a Node

Click **Add Node** to spawn a generic agent window.
By default, this node has no specific role. It behaves as a standard CLI interface to the configured provider (e.g., Claude, Codex), allowing you to interact with it directly.

## 5) Configure Roles & Modes

You can customize the node's behavior using **Roles** (templates for custom instructions):

- **Orchestrator**: Capable of spawning and managing subagents.
- **Coder**: Specialized for implementation and file editing.
- **Planner**: Optimized for requirements analysis and documentation.
- **Custom**: Define your own instructions and capabilities.

You can also control the execution **Mode** for each node:
- **Interactive**: You manually drive the conversation, prompting the agent step-by-step.
- **Auto**: The node executes a loop, continuously working towards its goal or processing inputs from upstream nodes.

## 6) Build a Flow

You can create complex workflows by adding multiple nodes and connecting them:

- **Chains**: Connect Node A -> Node B to pass outputs as inputs.
- **Loops**: Create feedback cycles (e.g., Coder -> Verifier -> Coder) to iterate on solutions.
- **Orchestration**: Use an Orchestrator node to dynamically spawn and manage sub-nodes based on the task at hand.

## 7) Global Context

Use the global **Planning / Implementation** toggle to guide agent behavior:

- **Planning Mode**: Agents ask questions, identify gaps, and write only to the `/docs/` directory. No code changes are applied.
- **Implementation Mode**: Agents can propose and apply code changes. 
  - Subagents may apply safe, scaffolding changes.
  - High-risk changes are typically reconciled and applied by the Orchestrator.
