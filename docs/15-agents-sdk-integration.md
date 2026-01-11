# Agents SDK integration (v1+)

v0 implements orchestration directly inside the daemon. This is intentionally lightweight and local-first.

For v1+, you can optionally adopt the **OpenAI Agents SDK** as a control-plane abstraction for:

- agent sessions
- handoffs
- guardrails
- tracing

## Why use the Agents SDK?

If you want deeper, standardized observability:

- Treat each vuhlp node as a trace span
- Treat each handoff edge as an SDK handoff
- Persist trace data for replay/export
- Reuse guardrails for verification gates

## Proposed mapping

| vuhlp concept | Agents SDK concept |
|---|---|
| Run | Session / trace root |
| Orchestrator node | “Coordinator” agent |
| Task node | Worker agent invocation |
| Edge (handoff) | Handoff |
| Verification node | Guardrail / tool-based check |
| Artifact | Trace attachment |

## Provider execution

Even when using Agents SDK for the orchestration semantics, you can still execute Codex/Claude/Gemini via adapters:

- Codex:
  - SDK calls to Codex or MCP server mode
- Claude/Gemini:
  - CLI-based adapters remain the execution substrate

The key is: Agents SDK acts as the **state machine + trace layer**, while adapters act as the **execution layer**.

## UI implications

If you store SDK traces, the UI can render:

- node spans with start/end times
- nested spans for tool calls and commands
- timeline view (v1)

## What to change in vuhlp code

- Replace the v0 `EventBus` as the canonical store with:
  - trace events (SDK) + a thin compatibility layer for UI
- Keep the v0 event schema as a “public UI contract” at the boundary
- Add a trace exporter (JSON) and import

## Notes

- This doc intentionally avoids SDK implementation details to keep v0 dependency-free.
- v1 should add a `controlPlane.kind` config:
  - `native` (v0 engine)
  - `agents-sdk`
