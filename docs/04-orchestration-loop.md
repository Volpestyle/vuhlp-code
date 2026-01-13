# Orchestration Loop

v0 implements an 8-phase state machine:

```
BOOT → DOCS_ITERATION → INVESTIGATE → PLAN → EXECUTE → VERIFY → DOCS_SYNC → DONE
         (conditional)                          ↑         |
                                                └─────────┘
                                              (loop on failure)
```

## Phase 1: BOOT

Goal: Initialize the run environment.

Actions:
- Load project configuration
- Detect repo state (empty, has code, has docs)
- Load docs index
- Detect harness availability and auth status
- Create root orchestrator node

## Phase 2: DOCS_ITERATION (Conditional)

> **[NOT FULLY IMPLEMENTED]** Types and triggers defined, but full doc-agent workflow is v1.

Goal: Ensure documentation exists before implementation.

Triggered when:
- Repo is empty
- Repo has only `/docs` (or no code)
- Docs are missing critical sections required to implement safely

Actions:
- Spawn specialized doc-agent roles (architecture-drafter, ux-spec-drafter, etc.)
- Generate/update docs until a coherent implementable contract exists
- Review and merge doc contributions

Outcome: Doc set that can support plan/implement phases.

## Phase 3: INVESTIGATE

Goal: Build context about the project.

Typical outputs:
- Project type (node/python/go/etc.)
- How to run tests
- Likely entrypoints / important folders
- Constraints and risks
- Existing architecture patterns

The investigator agent scans the repo and produces a "fact base" stored as `repoFacts` on the run.

## Phase 4: PLAN

Goal: Produce a machine-readable plan (DAG of steps).

Actions:
- Planner agent creates task graph with dependencies
- Generate acceptance criteria
- Produce/refresh planning artifacts

v0 plan schema: `docs/schemas/plan.schema.json`

The plan is stored as `taskDag` on the run with steps and their dependencies.

## Phase 5: EXECUTE

Goal: Implement the planned changes.

Actions:
- Schedule ready tasks (dependencies met) to provider agents
- Run in parallel up to `scheduler.maxConcurrency`
- Each task runs in a workspace and can generate artifacts:
  - diffs
  - logs
  - JSON structured outputs
- Update graph with streaming progress
- Track session IDs for provider continuity

## Phase 6: VERIFY

Goal: Validate the implementation.

Verifier runs configured commands (examples):
- `npm test`
- `pnpm lint`
- `pytest`
- `go test ./...`

Output is captured and stored as artifacts with:
- Exit code
- stdout/stderr
- Duration
- Pass/fail status

If verification fails:
- Create new "fix" task with:
  - Failing test logs
  - Verification report
  - Last patch summary
- Return to EXECUTE phase
- Increment iteration counter

Loop ends when:
- Verification PASS
- `maxIterations` reached
- Run stopped by user

## Phase 7: DOCS_SYNC (Checkpoint)

> **[NOT FULLY IMPLEMENTED]** Phase defined in types, minimal implementation in v0.

Goal: Update documentation to match reality.

Actions:
- Record decisions made during implementation
- Generate changelog entries
- Update architecture docs if behavior changed
- Final doc review gate

## Phase 8: DONE

Goal: Finalize and export.

Actions:
- Mark run as completed
- Export final report
- Preserve all artifacts
- Clean up temporary workspaces (if configured)

---

## Run Modes

The orchestration loop respects two modes:

### AUTO Mode

- Orchestrator dispatches prompts to agents without user intervention
- Re-prompts agents multiple times until completion (within budgets)
- Automatically handles verification loops

### INTERACTIVE Mode

- Orchestrator pauses scheduling
- User manually drives prompts/approvals
- Running turns complete, but no new turns start
- User can inspect, modify, and resume

Mode can be toggled at any time via the API or UI.

---

## Self-Looping Definition

A Run loops until ALL of these conditions are met:
1. All plan tasks are Done
2. Acceptance checks pass
3. Docs are updated to reflect final system state
4. Completeness verifier returns success

If any fail: loop continues (EXECUTE ↔ VERIFY ↔ DOCS_SYNC).

---

## Implementation Status

| Phase | Status |
|-------|--------|
| BOOT | Implemented |
| DOCS_ITERATION | Types defined, triggers work, full workflow is v1 |
| INVESTIGATE | Implemented |
| PLAN | Implemented |
| EXECUTE | Implemented |
| VERIFY | Implemented |
| DOCS_SYNC | Types defined, minimal implementation |
| DONE | Implemented |
