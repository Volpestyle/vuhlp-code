# Configuration

v0 reads config from:

- `vuhlp.config.json` in the current working directory (preferred)
- `VUHLP_CONFIG` environment variable pointing to a custom config path
- Environment variables for specific overrides

## Complete Configuration Reference

### TypeScript Interface

```typescript
interface VuhlpConfig {
  server?: { port?: number };
  dataDir?: string;
  defaultProvider?: string;
  providers?: Record<string, ProviderConfig>;
  roles?: Record<string, string>;
  scheduler?: { maxConcurrency?: number };
  orchestration?: {
    maxIterations?: number;
    maxTurnsPerNode?: number;
    defaultRunMode?: "AUTO" | "INTERACTIVE";
  };
  planning?: { docsDirectory?: string };
  node_defaults?: {
    defaultMode?: "auto" | "manual";
    maxTurnsPerLoop?: number;
  };
  workspace?: {
    mode?: "shared" | "worktree" | "copy";
    rootDir?: string;
    cleanupOnDone?: boolean;
  };
  verification?: { commands?: string[] };
  logging?: {
    level?: "debug" | "info" | "warn" | "error";
    dir?: string;
    retentionDays?: string;
  };
}
```

### Full Example

```json
{
  "server": {
    "port": 4317
  },
  "dataDir": ".vuhlp",
  "defaultProvider": "claude",
  "providers": {
    "mock": { "kind": "mock" },
    "codex": {
      "kind": "codex-cli",
      "command": "codex",
      "args": ["exec", "--json"]
    },
    "claude": {
      "kind": "claude-cli",
      "command": "claude",
      "args": ["-p", "{prompt}", "--output-format", "stream-json"]
    },
    "gemini": {
      "kind": "gemini-cli",
      "command": "gemini",
      "approvalMode": "auto_edit",
      "allowedTools": "read_file,write_file,run_command,list_files,search_files"
    }
  },
  "roles": {
    "investigator": "claude",
    "planner": "claude",
    "implementer": "claude",
    "reviewer": "claude"
  },
  "scheduler": {
    "maxConcurrency": 3
  },
  "orchestration": {
    "maxIterations": 3,
    "maxTurnsPerNode": 2,
    "defaultRunMode": "INTERACTIVE"
  },
  "planning": {
    "docsDirectory": "docs"
  },
  "node_defaults": {
    "defaultMode": "auto",
    "maxTurnsPerLoop": 10
  },
  "workspace": {
    "mode": "shared",
    "rootDir": ".vuhlp/workspaces",
    "cleanupOnDone": false
  },
  "verification": {
    "commands": ["npm run lint", "npm test"]
  },
  "logging": {
    "level": "info",
    "dir": "logs",
    "retentionDays": "14d"
  }
}
```

---

## Configuration Sections

### `server`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `port` | `number` | `4317` | HTTP/WebSocket server port |

### `dataDir`

| Type | Default | Description |
|------|---------|-------------|
| `string` | `".vuhlp"` | Directory for session data, logs, and state |

### `defaultProvider`

| Type | Default | Description |
|------|---------|-------------|
| `string` | `"mock"` | Provider used when creating new nodes |

### `providers`

Map of provider configurations. Keys are provider names, values are provider configs.

```json
{
  "providers": {
    "<name>": {
      "kind": "claude-cli" | "codex-cli" | "gemini-cli" | "mock",
      "command": "path/to/cli",
      "args": ["--flag", "value"],
      "approvalMode": "auto_edit",
      "allowedTools": "tool1,tool2"
    }
  }
}
```

See [Provider Adapters](./05-provider-adapters.md) for provider-specific options.

### `roles`

Maps role names to provider names. Determines which provider handles each role type.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `investigator` | `string` | `"mock"` | Provider for investigation tasks |
| `planner` | `string` | `"mock"` | Provider for planning tasks |
| `implementer` | `string` | `"mock"` | Provider for implementation tasks |
| `reviewer` | `string` | `"mock"` | Provider for code review tasks |

### `scheduler`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxConcurrency` | `number` | `3` | Maximum nodes executing in parallel |

### `orchestration`

Controls the orchestration loop behavior.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxIterations` | `number` | `3` | Maximum iterations of the orchestration loop |
| `maxTurnsPerNode` | `number` | `2` | Maximum turns per node within one iteration |
| `defaultRunMode` | `"AUTO" \| "INTERACTIVE"` | `"INTERACTIVE"` | Default mode for new runs |

### `planning`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `docsDirectory` | `string` | `"docs"` | Directory where agents write in Planning mode |

### `node_defaults`

Default settings applied to new nodes.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `defaultMode` | `"auto" \| "manual"` | `"auto"` | Default node execution mode |
| `maxTurnsPerLoop` | `number` | `10` | Maximum turns before pausing in Auto mode |

### `workspace`

Controls how parallel agents handle file access.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `mode` | `"shared" \| "worktree" \| "copy"` | `"shared"` | Workspace isolation strategy |
| `rootDir` | `string` | `".vuhlp/workspaces"` | Root directory for workspaces |
| `cleanupOnDone` | `boolean` | `false` | Remove workspaces after completion |

**Workspace Modes**:
- `shared` — All nodes work in the same directory (fast, potential conflicts)
- `worktree` — Each node gets an isolated git worktree (requires git repo)
- `copy` — Each node gets a full copy (slow but safe)

### `verification`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `commands` | `string[]` | `[]` | Commands to run for verification (lint, test, build) |

### `logging`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `level` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | Minimum log level |
| `dir` | `string` | `"logs"` | Directory for log files |
| `retentionDays` | `string` | `"14d"` | Log retention period |

---

## Environment Variables

| Variable | Overrides | Description |
|----------|-----------|-------------|
| `VUHLP_CONFIG` | — | Path to custom config file |
| `VUHLP_PORT` | `server.port` | Server port |
| `VUHLP_DATA_DIR` | `dataDir` | Data directory |

---

## Defaults Summary

When no config file exists, these defaults apply:

```json
{
  "server": { "port": 4317 },
  "dataDir": ".vuhlp",
  "defaultProvider": "mock",
  "providers": { "mock": { "kind": "mock" } },
  "roles": {
    "investigator": "mock",
    "planner": "mock",
    "implementer": "mock",
    "reviewer": "mock"
  },
  "scheduler": { "maxConcurrency": 3 },
  "orchestration": {
    "maxIterations": 3,
    "maxTurnsPerNode": 2,
    "defaultRunMode": "INTERACTIVE"
  },
  "planning": { "docsDirectory": "docs" },
  "node_defaults": { "defaultMode": "auto", "maxTurnsPerLoop": 10 },
  "workspace": {
    "mode": "shared",
    "rootDir": ".vuhlp/workspaces",
    "cleanupOnDone": false
  },
  "verification": { "commands": [] },
  "logging": { "level": "info", "dir": "logs", "retentionDays": "14d" }
}
```
