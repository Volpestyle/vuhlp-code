# Agent Parameters and Permissions

This document defines the configurable parameters for agent nodes and how permissions are enforced.

## Objectives
- Clear, editable node configuration.
- Permissions are opt-in per node.
- Full visibility into prompts, tools, and artifacts.

## Node configuration model
Each node has a resolved configuration snapshot stored in run state. Updates must be explicit and logged.

### Node configuration (example)

```
{
  "id": "node-123",
  "label": "Implementer A",
  "alias": "impl-a",
  "provider": "claude",
  "roleTemplate": "implementer",
  "customSystemPrompt": null,
  "capabilities": {
    "edgeManagement": "none",
    "writeCode": true,
    "writeDocs": true,
    "runCommands": true,
    "delegateOnly": false
  },
  "permissions": {
    "cliPermissionsMode": "skip",
    "agentManagementRequiresApproval": true
  },
  "session": {
    "resume": true,
    "resetCommands": ["/new", "/clear"]
  }
}
```

## Parameter groups

### 1) Identity
- **label**: User-facing node name.
- **alias**: Optional stable identifier for tool calls (unique per run).
- **roleTemplate**: Template name used to build the role prompt.
- **customSystemPrompt**: Optional override for the role prompt.

### 2) Provider selection (env-driven)
Providers are resolved from environment variables by the daemon. Supported providers: `codex`, `claude`, `gemini`, `custom`.

Common envs:
- `VUHLP_<PROVIDER>_TRANSPORT=cli|api`
- `VUHLP_<PROVIDER>_COMMAND` (CLI override)
- `VUHLP_<PROVIDER>_ARGS` (CLI args)
- `VUHLP_<PROVIDER>_PROTOCOL` (raw/stream-json/jsonl; Claude/Codex are forced)
- `VUHLP_<PROVIDER>_STATEFUL_STREAMING` (0/1, ignored for Claude/Codex)
- `VUHLP_<PROVIDER>_RESUME_ARGS`
- `VUHLP_<PROVIDER>_REPLAY_TURNS`
- `VUHLP_<PROVIDER>_NATIVE_TOOLS=provider|vuhlp`

API transport envs:
- `VUHLP_<PROVIDER>_API_KEY`
- `VUHLP_<PROVIDER>_API_URL`
- `VUHLP_<PROVIDER>_MODEL`
- `VUHLP_<PROVIDER>_MAX_TOKENS`

Provider behavior defaults:
- **Claude**: stream-json input/output, stdin kept open, always stateful.
- **Codex**: uses local fork (`packages/providers/codex`) and runs `codex vuhlp` (jsonl stdin/stdout).
- **Gemini**: stream-json input/output; local fork recommended for stream-json stdin.

### 3) Capabilities (opt-in)
Capabilities gate actions; global mode gates are applied on top.

- **edgeManagement**: `none` | `self` | `all`
- **writeCode**: allow code edits
- **writeDocs**: allow docs edits
- **runCommands**: allow shell commands
- **delegateOnly**: if true, node must not apply edits

### 4) Permissions (node-level)
- **cliPermissionsMode**:
  - `skip`: CLI executes tools immediately
  - `gated`: approval events are required
- **agentManagementRequiresApproval**: required for `spawn_node` and `create_edge` even when CLI permissions are skipped

### 5) Visibility controls (always on)
- Prompts logged as artifacts
- Tool usage emitted as events
- Artifacts listed per node

## Mode gates (Planning vs Implementation)
Planning mode enforces docs-only writes for vuhlp tool execution. Provider-native tools rely on prompt discipline.

## Agent management gating
Nodes can only spawn or create edges if:
1) Capability scope allows it.
2) Approval is granted when required.
3) Target node/edge fields are explicit.

## Session reset behavior
The UI can reset a node:
- Sends reset commands (`/new`, `/clear`) when available.
- Otherwise starts a fresh session.

## Open questions
- None. Update as new agent capabilities are introduced.
