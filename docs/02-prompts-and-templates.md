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

## Agent templates
Templates are stored as editable prompt files. They are intended as starting points, not constraints. Each template is a single file so users can version and replace it.

Template files:
- `docs/templates/orchestrator.md`
- `docs/templates/planner.md`
- `docs/templates/implementer.md`
- `docs/templates/reviewer.md`
- `docs/templates/investigator.md`

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
capabilities = ["spawn_nodes", "delegate", "review_diffs"]
constraints = ["log_decisions", "avoid_unlogged_edits"]
```

This allows the UI and runtime to parse intent and show capabilities clearly.

## Capability gating (opt-in)
Spawning nodes and using high-risk tools should be opt-in per node. A node can only spawn other nodes if:
- The template declares the capability.
- The node settings allow it.
- The user approves (required for all non-orchestrator nodes; optional for orchestrator by policy).

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
