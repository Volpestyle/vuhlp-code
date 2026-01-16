# Agent Parameters and Permissions (v2)

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
  "provider": "claude",
  "roleTemplate": "implementer",
  "customSystemPrompt": null,
  "capabilities": {
    "spawnNodes": false,
    "writeCode": true,
    "writeDocs": true,
    "runCommands": true,
    "delegateOnly": false
  },
  "permissions": {
    "cliPermissionsMode": "skip",
    "spawnRequiresApproval": true
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
- **roleTemplate**: Template name used to build the role prompt.
- **customSystemPrompt**: Optional override; when set, it replaces the role prompt.

### 2) Provider selection
- **provider**: Which CLI provider to use for this node.
- **resume**: Whether the provider should resume prior sessions (default: true).
- **resetCommands**: Commands that the runtime can send to clear context (e.g., `/new`, `/clear`).

### 3) Capabilities (opt-in)
Capabilities determine what the agent is allowed to do. They are enforced by the runtime and the UI.

- **spawnNodes**: Ability to propose new nodes. Non-orchestrator nodes require approval; orchestrator approval is policy-controlled.
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
- **spawnRequiresApproval**: Required for all non-orchestrator nodes. Default `false` for orchestrator, but configurable.

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

## Spawn gating
Nodes can only spawn other nodes if all conditions are met:
1) `capabilities.spawnNodes` is true.
2) The user approves the spawn request when required (always for non-orchestrator nodes).
3) The spawned node’s settings are explicitly defined.

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
