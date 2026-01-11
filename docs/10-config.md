# Configuration

v0 reads config from:

- `apps/daemon/vuhlp.config.json` (preferred)
- or env vars for port and data dir

## Config schema

See: `docs/schemas/config.schema.json`

## Example

```json
{
  "server": {
    "port": 4317
  },
  "dataDir": ".vuhlp",
  "providers": {
    "mock": { "kind": "mock" },
    "codex": { "kind": "codex-cli", "command": "codex", "args": ["exec", "--json"] },
    "claude": { "kind": "claude-cli", "command": "claude" },
    "gemini": { "kind": "gemini-cli", "command": "gemini" }
  },
  "roles": {
    "investigator": "mock",
    "planner": "mock",
    "implementer": "mock",
    "reviewer": "mock"
  },
  "scheduler": {
    "maxConcurrency": 3
  },
  "orchestration": {
    "maxIterations": 3
  },
  "workspace": {
    "mode": "shared"
  },
  "verification": {
    "commands": []
  }
}
```

## Provider selection

You can point all roles at one provider, or mix:

```json
{
  "roles": {
    "planner": "claude",
    "implementer": "codex",
    "reviewer": "gemini"
  }
}
```

## Environment variables

- `VUHLP_PORT` overrides config port
- `VUHLP_DATA_DIR` overrides dataDir
