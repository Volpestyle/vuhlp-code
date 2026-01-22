# Orchestration Modes and Loop Safety

This document defines orchestration modes and loop safety behavior.

## Orchestration modes (global)

### AUTO
- Scheduler can auto-reprompt the orchestrator when idle.
- Nodes continue to process inputs as they arrive.

### INTERACTIVE
- No auto-reprompt for the orchestrator.
- Nodes still process inbox inputs and queued messages.

## Planning vs Implementation (global)
- **PLANNING**: docs-only writes for vuhlp tool execution.
- **IMPLEMENTATION**: code edits allowed (subject to node capabilities).

## Loop safety (visibility-first)
Loop safety is based on stall detection, not hard caps.

### Signals
- Output hash
- Diff hash (when available)
- Verification failure signature (when available)

### Stall detection
If the same signal repeats for N turns (default 20), the run is paused and a `run.stalled` event is emitted.

Configure N with:
- `VUHLP_STALL_THRESHOLD`

### Stall response
When stalled:
1) Run status is set to `paused`.
2) Node status is set to `blocked` with a `stalled` summary.
3) Evidence is emitted in `run.stalled`.

## Completion conditions
There is no automatic completion. Runs are marked complete by explicit user action or API patch.
