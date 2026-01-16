# Quickstart

## Prerequisites

Before starting vuhlp, you need at least one AI provider CLI installed:

### Option A: Claude Code (Recommended)

```bash
# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Verify installation
claude --version

# Authenticate (opens browser)
claude auth login
```

### Option B: OpenAI Codex

```bash
# Install Codex CLI
npm install -g @openai/codex

# Verify installation
codex --version

# Set API key
export OPENAI_API_KEY=sk-...
```

### Option C: Google Gemini

```bash
# Install Gemini CLI
npm install -g @google/gemini-cli

# Verify installation
gemini --version

# Authenticate
gemini auth login
```

### Option D: Mock Provider (No Setup Required)

The mock provider works out of the box for testing the UI without real AI calls.

---

## 1) Install dependencies

```bash
pnpm install
```

## 2) Configure your provider

Create or edit `vuhlp.config.json` in the project root:

```json
{
  "defaultProvider": "claude",
  "providers": {
    "mock": { "kind": "mock" },
    "claude": { "kind": "claude-cli", "command": "claude" },
    "codex": { "kind": "codex-cli", "command": "codex" },
    "gemini": { "kind": "gemini-cli", "command": "gemini" }
  }
}
```

Set `defaultProvider` to whichever CLI you have installed.

> See [Configuration Reference](./10-config.md) for all options.

## 3) Start the daemon + UI

```bash
pnpm dev
```

This starts:

- HTTP server: `http://localhost:4317`
- WebSocket: `ws://localhost:4317/ws`

## 4) Start a Session

Open the UI at `http://localhost:4317`. You start with a fresh workspace where you can build your orchestration flow. Unlike fixed pipelines, you have full control over the graph structure.

## 5) Add a Node

Click **Add Node** to spawn a generic agent window.
By default, this node has no specific role. It behaves as a standard CLI interface to the configured provider (e.g., Claude, Codex), allowing you to interact with it directly.

## 6) Configure Roles & Modes

You can customize the node's behavior using **Roles** (templates for custom instructions):

- **Orchestrator**: Capable of spawning and managing subagents.
- **Implementer**: Specialized for implementation and file editing.
- **Verifier**: Optimized for code review and verification.
- **Researcher**: Focused on investigation and analysis.
- **Custom**: Define your own instructions and capabilities.

You can also control the execution **Mode** for each node:
- **Interactive**: You manually drive the conversation, prompting the agent step-by-step.
- **Auto**: The node executes a loop, continuously working towards its goal or processing inputs from upstream nodes.

## 7) Build a Flow

You can create complex workflows by adding multiple nodes and connecting them:

- **Chains**: Connect Node A -> Node B to pass outputs as inputs.
- **Loops**: Create feedback cycles (e.g., Coder -> Verifier -> Coder) to iterate on solutions.
- **Orchestration**: Use an Orchestrator node to dynamically spawn and manage sub-nodes based on the task at hand.

> See [Orchestration Patterns](./04-orchestration-patterns.md) for detailed examples.

## 8) Global Context

Use the global **Planning / Implementation** toggle to guide agent behavior:

- **Planning Mode**: Agents ask questions, identify gaps, and write only to the `/docs/` directory. No code changes are applied.
- **Implementation Mode**: Agents can propose and apply code changes.
  - Subagents may apply safe, scaffolding changes.
  - High-risk changes are typically reconciled and applied by the Orchestrator.

---

## Next Steps

- [Core Concepts](./02-concepts.md) — Understand the vocabulary
- [Architecture](./03-architecture.md) — Learn the system layers
- [Orchestration Patterns](./04-orchestration-patterns.md) — Common workflow patterns
- [Provider Adapters](./05-provider-adapters.md) — Configure providers in detail
- [Configuration Reference](./10-config.md) — Full config schema
