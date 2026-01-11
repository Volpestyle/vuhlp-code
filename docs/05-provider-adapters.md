# Provider adapters

v0 supports these provider kinds:

- `mock` — no external dependencies
- `codex-cli`
- `claude-cli`
- `gemini-cli`

Adapters are implemented in:

- `apps/daemon/src/providers/*`

## Configuration

See `docs/10-config.md` and `docs/examples/vuhlp.config.sample.json`.

### Example

```json
{
  "providers": {
    "mock": { "kind": "mock" },
    "codex": { "kind": "codex-cli", "command": "codex" },
    "claude": { "kind": "claude-cli", "command": "claude" },
    "gemini": { "kind": "gemini-cli", "command": "gemini" }
  },
  "roles": {
    "investigator": "mock",
    "planner": "mock",
    "implementer": "mock",
    "reviewer": "mock"
  }
}
```

## Codex CLI adapter

The adapter spawns a command like:

```bash
codex exec --json "<prompt>"
```

It expects JSONL output and turns each JSON line into a `node.progress` event (best-effort).

Notes:
- Different Codex versions may emit different event shapes.
- v0 stores the raw JSONL stream as an artifact for debugging.

## Claude Code CLI adapter

The adapter spawns:

```bash
claude -p "<prompt>" --output-format stream-json
```

The adapter parses each JSON line as a progress event.

If your Claude Code version does not support `stream-json`,
switch to `--output-format json` and v0 will parse a single JSON object.

## Gemini CLI adapter

The adapter spawns:

```bash
gemini -p "<prompt>" --output-format json
```

Gemini CLI output formats can vary; v0 stores raw output.

## Adding a new provider

Implement the `ProviderAdapter` interface:

- `healthCheck()`
- `runTask()` returning an async iterator of `ProviderEvent`s

Then register in `ProviderRegistry`.
