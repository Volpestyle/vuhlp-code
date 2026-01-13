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
  "defaultProvider": "claude",
  "scheduler": {
    "maxConcurrency": 3
  },
  "node": {
    "maxTurnsPerLoop": 10,
    "defaultMode": "interactive"
  },
  "workspace": {
    "mode": "shared",
    "cleanupOnDone": false
  },
  "verification": {
    "commands": []
  },
  "planning": {
    "docsDirectory": "/docs/"
  }
}
```

## Configuration Options

### `defaultProvider`

The provider used when creating new nodes. Users can change per-node.

### `node.maxTurnsPerLoop`

Maximum turns a node executes in Auto mode before pausing. Prevents runaway loops.

### `node.defaultMode`

Default mode for new nodes: `"interactive"` (default) or `"auto"`.

### `planning.docsDirectory`

Directory where agents write in Planning mode. Defaults to `/docs/`.

### `workspace.mode`

How parallel agents handle file access:
- `shared` — All nodes work in the same directory
- `worktree` — Each node gets an isolated git worktree
- `copy` — Each node gets a full copy (slow but safe)

### `workspace.cleanupOnDone`

Remove worktree/copy workspaces after completion.

## Provider Configuration

Define available providers:

```json
{
  "providers": {
    "claude": {
      "kind": "claude-cli",
      "command": "claude",
      "injectClaudeMd": true
    },
    "codex": {
      "kind": "codex-cli",
      "command": "codex",
      "sandboxMode": "read-only",
      "injectAgentsMd": true
    },
    "gemini": {
      "kind": "gemini-cli",
      "command": "gemini"
    }
  }
}
```

See [Provider Adapters](./05-provider-adapters.md) for full provider options.

## Environment variables

- `VUHLP_PORT` overrides config port
- `VUHLP_DATA_DIR` overrides dataDir
