# Provider adapters

v0 supports these providers:

- `claude`
- `codex`
- `gemini`
- `custom`

Adapters live in `packages/providers` and are configured via environment variables (see [docs/10-config.md](10-config.md)).

## CLI defaults

### Claude
- Forced to `--output-format stream-json` and `--input-format stream-json`.
- Stdin kept open between turns.

### Codex
- Uses the local fork in `packages/providers/codex`.
- Runs `codex vuhlp` (jsonl stdin/stdout).

### Gemini
- Uses stream-json input/output.
- Local fork in `packages/providers/gemini-cli` recommended for stream-json stdin.

## Native tool handling

For Claude/Codex/Gemini, native tools are executed by the provider CLIs. Vuhlp only uses tool_call JSON for vuhlp-only tools in that mode (`spawn_node`, `create_edge`, `send_handoff`).

For other providers, vuhlp can execute tool_call JSON for file/command tools.
