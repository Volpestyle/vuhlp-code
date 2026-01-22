# Prompts and Agent Templates

This document defines how prompts are structured and how template-based agents are configured. The goal is predictable, auditable behavior across providers.

## Objectives
- Consistent prompt structure across providers.
- Editable role templates.
- Explicit capabilities and permissions in task payloads.
- Full prompt logging per turn.

## Prompt architecture
Prompts are built in layers, with the same ordering across providers:

1) System context
2) Role template
3) Mode preamble (PLANNING/IMPLEMENTATION)
4) Task payload (nodes, edges, messages, handoffs)

## Canonical prompt blocks
Each block is stored as an artifact for auditability.

### System context
A stable framing of orchestration behavior:
- Graph-first workflow
- Observability requirements
- Planning vs Implementation constraints
- Loop safety expectations

### Role template
Role templates are user-editable files (see Template resolution below).

### Mode preamble
Injected based on global mode:

PLANNING:
- Read-only repo access
- Write access allowed only in `docs/`
- Ask to switch to Implementation if code changes are needed

IMPLEMENTATION:
- Code edits allowed
- Docs updates allowed
- Run verification when appropriate

### Task payload
The task payload includes:
- Run/node metadata
- Capabilities + permissions
- Known nodes + edges (ids + aliases)
- Incoming messages and handoffs

## Template resolution
Templates are loaded in this order:

1. Repo overrides: `docs/templates/<template>.md`
2. System defaults: `packages/daemon/docs/templates/<template>.md`

## Default templates
- `orchestrator`
- `planner`
- `implementer`
- `reviewer`
- `investigator`

## Tool protocol (tool_call JSON)

Vuhlp supports tool_call JSON parsing from assistant output.

**Provider-native tools (Claude/Codex/Gemini):**
- Use native tools for file/command operations.
- Use tool_call JSON only for vuhlp-only tools: `spawn_node`, `create_edge`, `send_handoff`.

**Vuhlp-handled tools (non-native):**
- Use tool_call JSON for `command`, `read_file`, `write_file`, `list_files`, `delete_file`, `spawn_node`, `create_edge`, `send_handoff`.

Rules:
- One tool call per line.
- Line must be JSON only (no extra text).
- Use `args` (not `params`).
- Do not wrap tool_call JSON in markdown.

Example:

```
{"tool_call":{"id":"tool-1","name":"spawn_node","args":{"label":"Docs Agent","alias":"docs-agent","roleTemplate":"planner","instructions":"Summarize docs/.","provider":"claude"}}}
```

## Prompt logging requirements
Each turn logs:
- Full prompt (`prompt.full.txt`)
- Prompt blocks (`prompt.blocks.json`)
- Prompt hash

These artifacts enable reproducibility and stall detection.
