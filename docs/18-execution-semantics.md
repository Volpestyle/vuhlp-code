# Execution semantics (v0)

This document describes how the current daemon schedules and runs nodes.

## Storage model

- `state.json` is the authoritative snapshot for UI and API.
- `events.jsonl` is an append-only event log used for replay/debugging.

## Scheduler

- Only runs when `run.status === "running"`.
- A node is runnable when `status === "idle"` and it has inbox inputs, queued messages, a pending turn, or an auto-reprompt queued.
- AUTO mode auto-queues the orchestrator when idle.

## Inputs

- Handoff envelopes are queued per-node.
- Chat messages are queued per-node.
- When a node runs, it consumes all pending inputs for that turn.

## Prompt construction

PromptBuilder assembles:

1. System context
2. Role template (or custom system prompt)
3. Mode preamble (PLANNING / IMPLEMENTATION)
4. Task payload (nodes, edges, messages, handoffs)

Each turn emits prompt artifacts: `prompt.full.txt` and `prompt.blocks.json`.

## Outputs and handoffs

- Node output is recorded as `message.assistant.final`.
- Tool calls can be provider-native or tool_call JSON.
- `send_handoff` creates envelopes and queues target nodes.
- `spawn_node` and `create_edge` are handled explicitly by the runtime.

## Global mode enforcement

- Vuhlp tool execution enforces docs-only writes in PLANNING.
- Provider-native tools rely on prompt discipline.

## Not implemented in v0

- Join gates and trigger modes
- Verification phase execution
- Per-node time/cost budgets
- Automated docs sync
