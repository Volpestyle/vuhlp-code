# CLI Patches for Multi-Turn Streaming

Vuhlp relies on local CLI forks to support persistent multi-turn streaming.

## Local forks (submodules)

- **Codex**: `packages/providers/codex` (branch `vuhlp-jsonl`)
  - Command: `codex vuhlp`
  - Protocol: JSONL stdin/stdout with explicit turn boundaries
  - Patch notes: [packages/providers/codex/VUHLP_PATCHES.md](../packages/providers/codex/VUHLP_PATCHES.md)

- **Gemini**: `packages/providers/gemini-cli` (branch `vuhlp/stream-json-thoughts`)
  - Command: bundled `gemini` binary with `--input-format stream-json`
  - Protocol: stream-json stdin/stdout
  - Patch notes: [packages/providers/gemini-cli/VUHLP_PATCHES.md](../packages/providers/gemini-cli/VUHLP_PATCHES.md)

These forks are wired by `ProviderResolver` in `packages/daemon` and auto-detected under `VUHLP_APP_ROOT`.

## Build

```bash
pnpm build:codex-cli
pnpm build:gemini-cli
```

## Why patches are required

Upstream Codex and Gemini CLIs are one-shot. Vuhlp needs:
- stdin kept open between turns
- streaming JSON events
- explicit turn boundaries for scheduling and approvals

## Protocol summary (Codex `codex vuhlp`)

**Input (stdin):**
```
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}
{"type":"approval.resolved","approvalId":"xxx","resolution":{"status":"approved"}}
{"type":"session.end"}
```

**Output (stdout):**
```
{"type":"message.assistant.delta","delta":"Hello"}
{"type":"message.assistant.final","content":"Done."}
{"type":"tool.proposed","tool":{"id":"xxx","name":"command","args":{"cmd":"ls"}}}
{"type":"approval.requested","approvalId":"xxx","tool":{"id":"xxx","name":"command","args":{}}}
{"type":"message_stop"}
```

See [docs/resources/codex-vuhlp-jsonl.md](resources/codex-vuhlp-jsonl.md) for details.
