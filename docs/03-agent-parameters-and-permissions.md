# Agent Parameters and Permissions

This document defines the configurable parameters for agent nodes and how permissions are enforced. The goal is to make agent behavior predictable, safe, and fully observable.

## Objectives
- Provide a clear, editable parameter set for every node.
- Keep permissions opt-in per node.
- Support skip-permissions (default) and non-skip-permissions for all providers.
- Preserve full visibility into what each agent did (diffs, logs, artifacts).

## Node configuration model
Each node has a resolved configuration snapshot at creation time. Changes are allowed, but must be explicit and logged. The snapshot must be stored in the run state for auditability.

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
- **alias**: Optional stable identifier used in tool calls (must be unique per run).
- **roleTemplate**: Template name used to build the role prompt.
- **customSystemPrompt**: Optional override; when set, it replaces the role prompt.

### 2) Provider selection
- **provider**: Which CLI provider to use for this node.
- **resume**: Whether the provider should resume prior sessions (default: true).
- **resetCommands**: Commands that the runtime can send to clear context (e.g., `/new`, `/clear`).

For Claude Code CLI, vuhlp always uses stream-json output with stream-json input and keeps stdin open between turns. This is the only supported Claude CLI mode in vuhlp; use API transport if you need different behavior.
For Codex CLI, vuhlp uses the local fork in `packages/providers/codex` under `VUHLP_APP_ROOT` and runs `codex vuhlp` (JSONL stdin/stdout). Stdin stays open between turns for true statefulness. Protocol details: `docs/resources/codex-vuhlp-jsonl.md`.
For Gemini CLI, vuhlp uses stream-json output and sends `--input-format stream-json` by default; this requires a fork that supports stream-json stdin. Point `VUHLP_GEMINI_COMMAND` to the local fork. If you need upstream Gemini CLI, use API transport instead. Add `--core-tools none` if you want Gemini CLI to disable native tools; vuhlp still accepts tool_call JSON for vuhlp tools.
Native tool handling: Claude, Codex, and Gemini always execute their own native tools (vuhlp logs them). For other providers, set `VUHLP_<PROVIDER>_NATIVE_TOOLS=provider` to let the CLI execute its own native tools, or `VUHLP_<PROVIDER>_NATIVE_TOOLS=vuhlp` to have vuhlp execute native tool calls.

Runtime paths: `VUHLP_REPO_ROOT` sets the agent workspace root (default `process.cwd()`), while `VUHLP_APP_ROOT` points to the vuhlp codebase root used for bundled templates and local provider forks (default derived from the daemon package). Codex auto-detects the local fork at `${VUHLP_APP_ROOT}/packages/providers/codex` unless `VUHLP_CODEX_COMMAND` is set.

Note: stream-json/jsonl CLI providers are stateful by default (resume + replay); set `VUHLP_<PROVIDER>_STATEFUL_STREAMING=0` to force stateless execution (not supported for Claude or Codex CLI).
If a provider process disconnects, vuhlp forces a full prompt and (when resume args are unset) replays the last N turns (default 4, override with `VUHLP_<PROVIDER>_REPLAY_TURNS`).
For per-turn resume/continue, set `VUHLP_<PROVIDER>_RESUME_ARGS`. Claude and Codex CLI stdin modes ignore resume args.
Claude CLI ignores `VUHLP_CLAUDE_PROTOCOL` and always uses stream-json. Codex CLI ignores `VUHLP_CODEX_PROTOCOL` and always uses jsonl.
When `cliPermissionsMode=skip`, vuhlp adds provider skip flags (`--dangerously-skip-permissions` for Claude, `--yolo` for Gemini) if they are not already present.

### 3) Capabilities (opt-in)
Capabilities determine what the agent is allowed to do. They are enforced by the runtime and the UI.

- **edgeManagement**: Controls edge creation scope and spawn rights.
  - `none`: cannot create edges or spawn nodes.
  - `self`: can create edges only when one endpoint is itself.
  - `all`: can create edges between any nodes and spawn nodes.
- **writeCode**: Permission to modify code in Implementation mode.
- **writeDocs**: Permission to modify docs.
- **runCommands**: Permission to run CLI commands.
- **delegateOnly**: If true, the node must not apply edits; it may only delegate or report.

**Rule**: A node can only perform actions when both the capability is enabled and the global mode allows it.

### 4) Permissions (single level)
Permissions are enforced at the node level only. There are no run-level overrides.

- **cliPermissionsMode**:
  - `skip` (default): CLI executes tools immediately.
  - `gated`: CLI pauses for permission; runtime forwards approval events to the UI and back.
- **agentManagementRequiresApproval**: Required for all non-orchestrator nodes. Default `false` for orchestrator, but configurable. Applies to `spawn_node` and `create_edge`.

**Note**: The runtime does not attempt to classify tool risk. It forwards provider approval requests as-is.

### 5) Visibility controls (always on)
These are non-negotiable system behaviors:
- Prompts are logged as artifacts.
- Tool usage is logged as events.
- Diffs are captured and shown in the node inspector.
- Per-node artifacts are visible and filterable.

## Mode gates (Planning vs Implementation)
Planning mode allows docs + research only. Implementation mode allows code edits.

- In Planning:
  - `writeCode` is always treated as false.
  - `writeDocs` is allowed.
- In Implementation:
  - `writeCode` and `writeDocs` are allowed if capabilities enable them.

## Agent management gating
Nodes can only spawn or create edges if all conditions are met:
1) Capability scope allows the action:
   - `spawn_node` requires `capabilities.edgeManagement = "all"`.
   - `create_edge` requires `capabilities.edgeManagement = "self"` or `"all"` (self must be an endpoint for `"self"`).
2) The user approves the request when required (always for non-orchestrator nodes).
3) For `spawn_node`, the spawned node’s settings are explicitly defined.
4) For `create_edge`, `from` and `to` are explicitly defined.

Spawn is never implicit. It only happens via explicit `spawn_node` output or direct user action.

## Permission routing (ASCII)

```
Action Request
   |
   v
Global Mode Gate (Planning/Implementation)
   |
   v
Node Capabilities Gate (spawn/write/run)
   |
   v
Provider Permissions Mode
  - skip   -> execute immediately
  - gated  -> approval event -> UI -> user -> forward to CLI
```

## Session reset behavior
The UI must expose a clear “reset context” action for each node.

- If the provider supports session reset via command, send the command.
- If not, start a new session and drop the old one.
- Reset clears queued messages and skips resume/continue for the next turn to ensure a fresh session.
- Reset actions must be logged as events.

## Diff visibility (non-negotiable)
Each node must produce and surface its diffs:
- Diffs are captured as artifacts after each completed turn.
- The node inspector shows per-node diffs and change summaries.
- Diffs are required even if the agent reports “no changes.”

## Parameter changes at runtime
- Any parameter change must be logged with previous and new values.
- Changes apply on the next turn, not mid-turn.
- Provider switches should restart the session unless explicitly resumed.

## Open questions
- None. Update as new node capabilities are introduced.
