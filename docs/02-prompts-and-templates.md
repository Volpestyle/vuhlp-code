# Prompts and Agent Templates

This document defines how prompts are structured and how template-based agents are configured. The goal is to support highly autonomous agents while keeping orchestration behavior predictable and explainable.

## Objectives
- Provide consistent prompt structure across providers.
- Support editable, reusable role templates.
- Enable opt-in capabilities (tooling, spawning, write access).
- Keep prompts portable across CLI agents (Codex, Claude Code, Gemini, others).

## Prompt architecture
Prompts are built in layers, with the same ordering across providers:

1) System context
- Stable framing of the product philosophy and execution model.

2) Role template
- The agent’s identity, constraints, and behavior style.

3) Mode preamble
- Planning vs Implementation constraints.

4) Task payload
- Current task, inputs, artifacts, and expectations.

5) Optional user override
- Last-minute instructions or corrections.

## Canonical prompt blocks
Each block should be a pure string so it can be combined and logged. Store each block as an artifact for auditability.

### System context (core contract)
This block explains the orchestration system’s expectations:
- Graph-first workflow.
- Visibility and logging requirements.
- Planning vs Implementation constraints.
- Loop safety: avoid useless loops; report stalls.

### Role template (editable)
Role templates are user-editable, not fixed. The system ships with defaults, but users can override them.

Each role template should include:
- Identity: who the agent is and how it should behave.
- Responsibilities: concrete expectations.
- Constraints: what it must not do.
- Output style: required formatting if any.

### Mode preamble
The runtime injects explicit constraints based on global mode:

PLANNING:
- Read-only repo access.
- Write access allowed only in docs directory.
- Ask for Implementation mode if code changes are needed.

IMPLEMENTATION:
- Code edits allowed.
- Docs updates allowed.
- Use tests or verification commands when appropriate.

### Task payload
The task payload should include:
- Objective and definition of done.
- Incoming handoffs (messages, artifacts, context packs).
- Current workspace details.
- Known nodes and edges (labels + ids + aliases) so agents can call `create_edge` and `send_handoff` correctly.

## Agent templates
Templates are stored as editable prompt files. They are intended as starting points, not constraints. Each template is a single file so users can version and replace it.

### Template resolution
The runtime loads templates in this order:
1. **Repo override**: `{repoRoot}/docs/templates/{templateName}.md` - user-provided templates take priority
2. **System defaults**: `packages/daemon/docs/templates/{templateName}.md` - shipped defaults

This allows users to override any template by placing a file in their repo's `docs/templates/` directory.

### Default template files
- `packages/daemon/docs/templates/orchestrator.md`
- `packages/daemon/docs/templates/planner.md`
- `packages/daemon/docs/templates/implementer.md`
- `packages/daemon/docs/templates/reviewer.md`
- `packages/daemon/docs/templates/investigator.md`

### Orchestrator (default supervisor)
- Delegates work to other agents.
- Reviews outputs and diffs.
- Ensures docs and code align.
- Operates in Auto mode when enabled.

### Planner (docs + research)
- Summarizes repository state.
- Produces plans and acceptance criteria.
- Writes only to docs in Planning mode.

### Implementer (code changes)
- Applies code changes directly.
- Writes tests or verification commands as needed.
- Produces diffs as artifacts for review.

### Reviewer (verification + critique)
- Runs verification commands.
- Reviews diffs and highlights risks.
- Produces a structured review summary.

### Investigator (rapid research)
- Quick scan of repo or external information.
- Returns findings with minimal action.

## Template fields (recommended)
Each template should include a small, structured preamble block at the top:

```
[template]
name = "orchestrator"
version = "1"
capabilities = ["edge_management_all", "delegate", "review_diffs"]
constraints = ["log_decisions", "avoid_unlogged_edits"]
```

This allows the UI and runtime to parse intent and show capabilities clearly.

## Capability gating (opt-in)
Spawning nodes and using high-risk tools should be opt-in per node. A node can only spawn other nodes if:
- The template declares edge-management scope (recommended: `edge_management_all` for orchestrators).
- The node settings allow it.
- The user approves (required for all non-orchestrator nodes; optional for orchestrator by policy).

## CLI tool protocol (native + JSON)
CLI transports support tool calling in two ways:
- **Native tools** (preferred when available): Provider-native tool_use events. Claude, Codex, and Gemini always execute their own native tools; other CLIs default to vuhlp execution and can be toggled with `VUHLP_<PROVIDER>_NATIVE_TOOLS=provider|vuhlp`.
- **tool_call JSON**: emit a single-line JSON object in your response. vuhlp parses the line, executes the tool, and emits tool events for visibility. This is supported alongside streaming (stream-json) so you can keep progressive output.

In provider-native mode (Claude, Codex, Gemini), use native tools for file/command operations. Only emit tool_call JSON for vuhlp-only tools: `spawn_node`, `create_edge`, `send_handoff`.

Never use Bash to emit tool_call JSON. Emit the JSON directly in your assistant response.
Bash output containing tool_call JSON is treated as an error.
Only use spawn_node when Task Payload shows edgeManagement=all.
Only use create_edge when Task Payload shows edgeManagement=all or edgeManagement=self (self must be one endpoint).

```
{"tool_call":{"id":"uuid","name":"spawn_node","args":{"label":"Docs Agent","roleTemplate":"planner"}}}
```

Rules:
- One tool call per line.
- The line must be JSON only (no extra text).
- Use `args` (not `params`) for tool_call JSON.
- Do not wrap tool_call JSON in markdown or code fences.
- Only emit tool_call JSON when invoking a tool (do not include it in explanations).
- Outgoing handoffs are explicit; use `send_handoff` when you need to message another node.
- `send_handoff` requires an edge between sender and receiver.
- Use `spawn_node` aliases to reference newly spawned nodes within the same response.
- Aliases must be unique within the run.
- `tool_call.id` can be any short unique string or omitted (vuhlp will generate one). Do not call Bash to generate ids.

Tool schemas (tool_call args):
- `command`: `{ cmd: string, cwd?: string }`
- `read_file`: `{ path: string }`
- `write_file`: `{ path: string, content: string }`
- `list_files`: `{ path?: string }`
- `delete_file`: `{ path: string }`
- `spawn_node`: `{ label: string, alias?: string, roleTemplate: string, instructions?: string, input?: object, provider?: string, capabilities?: object, permissions?: object, session?: object, customSystemPrompt?: string }`
- `create_edge`: `{ from: string, to: string, bidirectional?: boolean, type?: "handoff" | "report", label?: string }` (from/to = node id or alias)
- `send_handoff`: `{ to: string, message: string, structured?: object, artifacts?: [{type: string, ref: string}], status?: {ok: boolean, reason?: string}, response?: {expectation: "none" | "optional" | "required", replyTo?: string}, contextRef?: string }` (to/replyTo = node id or alias)

Examples (single-line JSON only):

```
{"tool_call":{"id":"tool-1","name":"spawn_node","args":{"label":"Docs Agent","alias":"docs-agent","roleTemplate":"planner","instructions":"Summarize docs/.","provider":"claude"}}}
{"tool_call":{"id":"tool-2","name":"create_edge","args":{"from":"node-a","to":"docs-agent","type":"handoff","bidirectional":true,"label":"docs"}}}
{"tool_call":{"id":"tool-3","name":"send_handoff","args":{"to":"docs-agent","message":"Status update","response":{"expectation":"optional"}}}}
```

## Prompt logging requirements
Every prompt sent to a provider must be logged as an artifact:
- Full prompt string
- Split blocks (system, role, mode, task, override)
- Prompt hash for diffs and repeat detection

Diff visibility requirement:
- Implementers must emit diffs as artifacts so the node inspector can show per-agent changes clearly.

Note: If the runtime sends only a delta prompt to the provider, it must still reconstruct and log the full effective prompt for that turn.

This enables full reproducibility and loop debugging.

## Example prompt assembly (pseudocode)

```
prompt = system_context
prompt += "\n\n" + role_template
prompt += "\n\n" + mode_preamble
prompt += "\n\n" + task_payload
if user_override:
  prompt += "\n\n" + user_override
```

## Template examples (short)

### Orchestrator template (excerpt)

```
You are the orchestrator. Your job is to coordinate other agents and achieve the user’s goal.
Always:
- Delegate when parallel work will help.
- Review diffs from implementers.
- Keep docs aligned with implementation.
Never:
- Spawn nodes without permission when approval is required.
- Hide errors or tool usage.
```

### Implementer template (excerpt)

```
You are a specialist implementer. You can modify code directly in Implementation mode.
Always:
- Produce diffs as artifacts.
- Keep changes minimal and explain intent.
- Coordinate if working in parallel.
Never:
- Modify docs in Planning mode.
```

## Open questions
- None. Update as templates evolve.
