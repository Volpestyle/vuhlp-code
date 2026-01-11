# Orchestration loop

v0 implements a pragmatic loop:

1. **Investigation**
2. **Planning**
3. **Implementation**
4. **Verification**
5. **Iterate if verification fails**

## Phase 1: Investigation

Goal: build context.

Typical outputs:

- project type (node/python/go/etc.)
- how to run tests
- likely entrypoints / important folders
- constraints and risks

## Phase 2: Planning

Goal: produce a machine-readable plan (DAG-ish list of steps).

v0 plan schema: `docs/schemas/plan.schema.json`

Planner prompt should instruct the agent to output JSON matching the schema.

## Phase 3: Implementation

Plan steps are dispatched to provider agents in parallel (up to `scheduler.maxConcurrency`).

Each step runs in a workspace and can generate artifacts:

- diffs
- logs
- JSON structured outputs

## Phase 4: Verification

Verifier runs configured commands (examples):

- `npm test`
- `pnpm lint`
- `pytest`
- `go test ./...`

Output is captured and stored as artifacts.

## Phase 5: Looping

If verification fails:

- The orchestrator creates a new “fix” step with:
  - failing logs
  - the verification report
  - last patch summary
- Runs implementation again
- Re-verifies

Loop ends when:

- verification PASS
- or `maxIterations` reached
- or run stopped
