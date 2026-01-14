# Failure Modes and Recovery

A graph-first orchestration tool only feels “professional” if it fails gracefully.

This doc defines:

- the common failure modes for vuhlp
- the expected runtime behavior (auto retries, degradation, pauses)
- the recovery actions users can take
- the events/artifacts that MUST be emitted for debuggability

---

## Failure handling principles

1) **Prefer degradation over crash**
   - If parsing structured events fails, fall back to raw console.
2) **Prefer pausing over thrashing**
   - If repeated failures occur, pause and explain why.
3) **Never lose provenance**
   - Always store stdout/stderr transcripts and artifacts.
4) **Make recovery one click/command**
   - Retry, resume, fork, rollback.

---

## Provider/harness failures

### 1) Harness not installed / not found
**Detection:** spawn error (`ENOENT`) or non-zero “command not found”.

**Runtime response:**
- Mark node as `FAILED` with reason `provider_unavailable`.
- Emit a clear error artifact:
  - `missing_command`, `expected_path`, `install_hint`.
- Offer recovery:
  - “Change provider” (swap node provider)
  - “Open terminal” to install CLI

### 2) Authentication expired / not logged in
**Detection:** provider returns auth error; or `login status` indicates not logged in.

**Runtime response:**
- Mark node `BLOCKED_MANUAL_INPUT` (interactive action needed).
- Emit artifact: `auth_required` with next steps.
- UI should offer “Open Raw Console → Run login”.

### 3) Provider transient error (rate limit, network, server)
**Detection:** non-zero exit, known error patterns.

**Runtime response:**
- Auto retry with backoff:
  - `retryCount <= N` (default 2)
  - jittered exponential backoff
- If still failing:
  - pause node and recommend switching provider

---

## Streaming + parsing failures

### 4) Structured stream parse failure
Examples:
- invalid JSON lines
- schema drift after provider update

**Runtime response:**
- Continue capturing raw stdout/stderr.
- Emit `parser.warning` with:
  - first failing line (truncated)
  - provider version (if known)
- Do NOT fail the whole turn unless the node cannot produce any output.

**Recovery:**
- user can still read raw console
- update mapper or switch output-format

---

## Workspace + merge failures

### 5) Patch apply conflict
**Detection:** git apply/merge conflict markers.

**Runtime response:**
- Emit `artifact.conflict` listing files/hunks.
- Spawn (or suggest) a `Reconciler/Merger` node.
- Optionally pause to interactive.

### 6) Concurrent writes (race conditions)
**Detection:** overlapping diffs, same files modified in parallel.

**Runtime response:**
- Prefer prevention:
  - worktrees per node
  - file ownership hints
- If detected:
  - route to reconciliation node

---

## Verification failures

### 7) Deterministic failures (tests/lint/build)
**Detection:** verifier node returns failure artifact.

**Runtime response:**
- Route failure logs back to the relevant implementer.
- If failures implicate multiple changes:
  - spawn reconciliation node
- Cap fix-loop by loop safety policy.

### 8) Flaky tests / nondeterministic failures
**Detection:** failures appear/disappear without code changes.

**Runtime response:**
- Retry verifier once (or configurable).
- Mark as `flaky_suspected` and suggest:
  - isolate test
  - pin seed
  - reduce concurrency

---

## Loop stalls / runaway autonomy

### 9) Non-progress detected
**Detection:** loop safety system triggers stall.

**Runtime response:**
- Halt the cycle.
- Emit `loop.halted` with evidence + suggested actions.
- Default action: switch to interactive.

---

## User interruption / mode switching

### 10) User toggles to Interactive mid-turn
**Runtime response:**
- Let the current turn finish.
- Stop scheduling future turns.
- Mark ready nodes as `BLOCKED_MANUAL_INPUT`.

### 11) User cancels a node
**Runtime response:**
- Send SIGINT/SIGTERM to process if supported.
- Emit `node.canceled`.
- Preserve all partial output artifacts.

---

## State corruption / disk issues

### 12) Event store write failure
**Runtime response:**
- Pause run immediately.
- Emit error to console and UI.
- Prefer “fail closed” (don’t keep running without persistence).

---

## Standard recovery actions (must exist)

- **Retry Turn**: rerun the last turn with same inputs
- **Resume Session**: resume provider session id
- **Fork Node**: create new node with summarized context
- **Switch Provider**: rerun with a different harness
- **Rollback Workspace**: reset worktree to last known good

---

## Observability requirements

For every failure, vuhlp MUST store:

- raw stdout/stderr transcript (per turn)
- structured event stream (if available)
- exit codes and durations
- input context pack reference
- output payload(s) and artifacts

This ensures the UI (and `--viz`) can explain failures accurately.

---

## Related docs

- `docs/20-loop-safety-and-nonprogress.md`
- `docs/18-execution-semantics.md`
