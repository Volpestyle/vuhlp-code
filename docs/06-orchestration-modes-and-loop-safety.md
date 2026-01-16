# Orchestration Modes and Loop Safety (v2)

This document defines orchestration modes and the system’s loop safety strategy. The goal is to allow long-running autonomous workflows without wasteful loops, while keeping the user fully informed and in control.

## Objectives
- Define Auto vs Interactive orchestration clearly.
- Preserve agent autonomy with visibility.
- Detect and pause on useless loops.
- Avoid hard run-length caps.

## Orchestration modes (global)

### Auto
- The orchestrator can re-prompt itself to achieve the initial user goal.
- Nodes continue to process inputs as they arrive.
- The system runs until the objective is complete or the user interrupts.

### Interactive
- The orchestrator does not re-prompt itself.
- The user explicitly drives orchestrator turns.
- Other nodes still process inbox inputs unless paused by the user.

## Planning vs Implementation (global)
- **Planning**: Read-only repo, docs-only writes.
- **Implementation**: Code edits allowed, docs updates allowed.

Planning/Implementation is orthogonal to Auto/Interactive.

## Loop safety (visibility-first)
Loop safety is based on **observability** and **stall detection**, not hard caps.

### Required signals
- Node status (idle, running, blocked, failed).
- Last activity timestamp.
- Last output hash.
- Last diff hash (if any).
- Last verification status (if applicable).

### Stall detection heuristics
A stall is detected when any of the following repeats with no progress:
- Identical output hash for N turns.
- Identical diff hash for N turns.
- Identical verification failures for N turns.

Recommended default: N = 2 or 3 (configurable).

### Stall response
When a stall is detected:
1) Pause orchestration.
2) Notify the user with evidence:
   - last output hash
   - last diff hash
   - last verification failure (if any)
   - last 2–3 summaries
3) Provide suggested next actions (e.g., adjust prompt, reset node context).

No hard stop is enforced. The user decides whether to resume.

## Manual interruption
Users can:
- Interrupt a node mid-turn.
- Queue a message for the next turn.
- Reset a node’s context (/new or /clear) if available.

Interrupts are explicit and logged.

## Completion conditions
The system should consider a run “done” when:
- The orchestrator explicitly marks completion, or
- The user marks completion.

There is no automatic hard cap on run length.

## UI requirements
- A visible status badge for each node.
- A visible “stalled” badge when a loop is paused.
- Easy access to evidence for why the stall was triggered.

## Open questions
- None. Update as loop heuristics evolve.
