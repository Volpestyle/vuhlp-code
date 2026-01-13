# Provider Adapters

v0 supports these provider kinds:

- `mock` — no external dependencies
- `codex-cli`
- `claude-cli`
- `gemini-cli`

Adapters are implemented in:

- `apps/daemon/src/providers/*`
- Event mappers in `apps/daemon/src/providers/mappers/*`

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
  "defaultProvider": "claude"
}
```

When creating nodes, users select which provider to use. The `defaultProvider` is used for new nodes.

---

## Codex CLI Adapter

The adapter spawns a command like:

```bash
codex exec --json --sandbox read-only --ask-for-approval never "<prompt>"
```

It expects JSONL output and parses events through `codexMapper.ts`:
- `thread.started` → session ID captured
- `item.message` → assistant messages
- `item.reasoning` → chain-of-thought
- `item.command_execution` → tool events
- `item.file_change` → diff artifacts

**Session resumption:** `codex exec resume <thread_id>`

### Configuration Options

```json
{
  "kind": "codex-cli",
  "command": "codex",
  "args": [],
  "env": {},
  "sandboxMode": "read-only",
  "askForApproval": "never",
  "agentsMdPath": "./AGENTS.md",
  "injectAgentsMd": true
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `command` | `"codex"` | Path to codex CLI |
| `args` | `[]` | Custom CLI arguments (overrides defaults) |
| `env` | `{}` | Environment variables |
| `sandboxMode` | `"read-only"` | Sandbox mode: `read-only`, `read-write`, `none` |
| `askForApproval` | `"never"` | Approval mode: `always`, `never`, `auto` |
| `agentsMdPath` | auto-detect | Path to AGENTS.md file |
| `injectAgentsMd` | `true` | Auto-inject AGENTS.md into prompts |

### AGENTS.md Injection

The Codex adapter automatically injects project instructions from `AGENTS.md` into prompts. It searches for the file in:

1. Configured `agentsMdPath`
2. `{workspace}/AGENTS.md`
3. `{workspace}/.github/AGENTS.md`
4. `{workspace}/docs/AGENTS.md`

Set `injectAgentsMd: false` to disable.

Notes:
- Different Codex versions may emit different event shapes.
- v0 stores the raw JSONL stream as an artifact for debugging.

---

## Claude Code CLI Adapter

The adapter spawns:

```bash
claude -p "<prompt>" --output-format stream-json --include-partial-messages
```

Events are parsed through `claudeMapper.ts`:
- `init` → session ID captured
- `assistant_partial` → streaming deltas
- `assistant` / `tool_use` → tool proposals
- `tool_result` → tool completions

**Session resumption:** `--session-id <uuid>` or `--resume <id>`

### Configuration Options

```json
{
  "kind": "claude-cli",
  "command": "claude",
  "args": [],
  "env": {},
  "includePartialMessages": true,
  "claudeMdPath": "./CLAUDE.md",
  "injectClaudeMd": true
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `command` | `"claude"` | Path to claude CLI |
| `args` | `[]` | Custom CLI arguments (overrides defaults) |
| `env` | `{}` | Environment variables |
| `includePartialMessages` | `true` | Include streaming partial messages |
| `claudeMdPath` | auto-detect | Path to CLAUDE.md file |
| `injectClaudeMd` | `true` | Auto-inject CLAUDE.md into prompts |

### CLAUDE.md Injection

The Claude adapter automatically injects project instructions from `CLAUDE.md` into prompts. It searches for the file in:

1. Configured `claudeMdPath`
2. `{workspace}/CLAUDE.md`
3. `{workspace}/.claude/CLAUDE.md`

Set `injectClaudeMd: false` to disable.

If your Claude Code version does not support `stream-json`, switch to `--output-format json` via custom `args`.

---

## Gemini CLI Adapter

The adapter spawns:

```bash
gemini -p "<prompt>" --output-format stream-json
```

Events are parsed through `geminiMapper.ts`:
- `init` → session ID captured
- `delta` → streaming text
- `thinking` → reasoning output
- `tool_use` / `tool_result` → tool events

**Session resumption:** `--resume <session_id>`

### Configuration Options

```json
{
  "kind": "gemini-cli",
  "command": "gemini",
  "args": [],
  "env": {}
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `command` | `"gemini"` | Path to gemini CLI |
| `args` | `[]` | Custom CLI arguments |
| `env` | `{}` | Environment variables |

Gemini CLI output formats can vary; v0 stores raw output as artifacts.

---

## Mock Provider

The mock provider requires no external dependencies. It returns simulated responses for testing orchestration workflows without real AI calls.

Useful for:
- Development and testing
- Demonstrating the UI
- Offline scenarios

---

## Provider Capabilities

Each adapter declares its capabilities:

```typescript
{
  streaming: boolean;        // Supports streaming output
  structuredOutput: boolean; // Supports JSON schema output
  resumableSessions: boolean; // Supports session continuity
}
```

| Provider | Streaming | Structured Output | Resumable Sessions |
|----------|-----------|-------------------|-------------------|
| mock | No | No | No |
| codex-cli | Yes | Yes | Yes |
| claude-cli | Yes | Yes | Yes |
| gemini-cli | Yes | Yes | Yes |

---

## Tool Risk Levels

Provider mappers assign risk levels to tool proposals:

| Risk | Tools |
|------|-------|
| `low` | Read, Glob, Grep, LSP, WebSearch, WebFetch |
| `medium` | Write, Edit, npm commands |
| `high` | Bash with `rm`, `mv`, `chmod`, `chown`, `sudo`, `dd`, `mkfs`, `kill` |

Risk levels are used by the approval queue to determine which tools need human approval.

---

## Adding a New Provider

Implement the `ProviderAdapter` interface:

```typescript
interface ProviderAdapter {
  id: string;
  displayName: string;
  kind: string;
  capabilities: {
    streaming: boolean;
    structuredOutput: boolean;
    resumableSessions: boolean;
  };

  healthCheck(): Promise<ProviderHealth>;
  runTask(task: ProviderTask, signal: AbortSignal): AsyncIterable<ProviderOutputEvent>;
}
```

Then register in `ProviderRegistry` (`apps/daemon/src/providers/registry.ts`).

### Event Types to Emit

Your `runTask()` should yield these event types:

- `progress` — Text progress updates
- `log` — Named log content
- `json` — Structured JSON output
- `diff` — Patch content
- `final` — Completion with optional summary
- `console` — Raw stdout/stderr chunks
- `session` — Provider session ID for continuity
- `message.delta` — Streaming text deltas
- `message.final` — Complete message content
- `message.reasoning` — Chain-of-thought content
- `tool.proposed` — Tool proposal for approval
- `tool.started` — Tool execution started
- `tool.completed` — Tool execution finished
