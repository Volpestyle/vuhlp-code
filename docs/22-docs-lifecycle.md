# Docs Lifecycle (Docs-First Autonomy)

vuhlp optimizes for **full autonomy** without guesswork.

The baseline rule is simple:

> **If there is ambiguity, docs come first.**

Docs are not “nice to have.” In vuhlp, docs are an executable contract that:

- constrains agent behavior
- reduces hallucination
- enables verification
- makes long runs coherent

This document defines:

- the Planning vs Implementation mode contract
- the “docs iteration phase” (empty repo / docs-only repo)
- how docs are created, reviewed, and kept in sync

---

## Key concepts

### Docs as contract
Certain docs are treated as **source-of-truth**. In Implementation mode, agents MUST prefer these docs over their own prior guesses.

### Doc checkpoints
After every major loop checkpoint (e.g., feature complete, tests pass), vuhlp runs a **Docs Sync** step that updates docs to match reality.

### Final doc reviewer
For high-stakes documentation quality, vuhlp may invoke a “final reviewer/synthesizer” (e.g., GPT-5.2 Pro via API) to:

- merge drafts
- remove contradictions
- enforce style and completeness

---

## Required docs set

The following files are recommended in `/docs`:

1) `OVERVIEW.md` — what this project is
2) `ARCHITECTURE.md` — key components + data flows
3) `ACCEPTANCE.md` — definition of done / acceptance checklist
4) `PLAN.md` — current plan DAG / milestone plan
5) `DECISIONS.md` — ADR-style decisions + rationale
6) `RUNBOOK.md` — how to build/test/release/debug

vuhlp SHOULD be able to operate if some are missing, but it MUST enter Planning mode to fill critical gaps.

---

## Repo classification (startup)

At run start, classify the repo to provide **context** to the Root Agent:

### Case A: Empty repo
- No code, no docs
- Context: `missingRequiredDocs` alert
- **Action**: Boot Root Agent. Agent decides whether to enter **Docs Iteration Phase** or ask user.

### Case B: Docs-only repo
- `/docs` exists, little/no code
- Context: `missingRequiredDocs` alert (if incomplete)
- **Action**: Boot Root Agent. Agent decides next step.

### Case C: Code repo with weak docs
- Code exists but missing contract docs
- Context: `missingRequiredDocs` alert
- **Action**: Boot Root Agent. Agent typically requests **Docs Iteration** or Planning mode.

### Case D: Healthy code + docs
- **Action**: Boot Root Agent. Proceed normally.

---

## Planning mode contract

In Planning mode:

- Codebase is treated as **read-only**.
- Agents MUST write only to `/docs` (or configured docs root).
- The goal is to produce an implementable contract:
  - clear requirements
  - clear acceptance criteria
  - clear plan steps
  - risks and unknowns documented

Verification in Planning mode checks:
- “Does the plan have gaps?”
- “Are acceptance criteria testable?”
- “Do docs contradict each other?”

---

## Implementation mode contract

In Implementation mode:

- Agents MAY propose and apply code changes (subject to tool policy).
- The docs contract is source-of-truth.
- If the implementation must diverge from docs:
  - update docs first (or at least in the same checkpoint)

Verification in Implementation mode checks:
- tests/build/lint pass
- acceptance checklist satisfied
- docs synced

---

## Docs Iteration Phase

Triggered by empty/docs-only repo, or missing critical docs.

### Phase outputs
Docs iteration MUST produce:

- a coherent `/docs` directory
- a Plan that can be executed
- acceptance criteria that can be verified

### Recommended pipeline

1) **Docs Gap Analysis** (orchestrator)
   - Identify missing docs.
   - Identify unknowns.

2) **Draft in parallel** (subagents)
   - Architecture drafter
   - Plan drafter
   - Acceptance drafter
   - Runbook drafter

3) **Synthesis + consistency pass**
   - Merge drafts into a single consistent set.
   - Resolve contradictions.

4) **Final doc review (GPT-5.2 Pro)**
   - Enforce:
     - completeness
     - non-contradiction
     - actionable acceptance criteria

5) **Publish**
   - Write docs into `/docs`.
   - Emit artifacts + provenance.

6) Exit to Planning (or directly to Implementation if requested).

---

## Docs Sync checkpoint (every major loop)

After each major iteration checkpoint, vuhlp runs a Docs Sync step.

### When to run Docs Sync
Docs Sync MUST run when:

- verification transitions from fail → pass
- a major feature milestone completes
- public API shape changed
- any `/docs/*contract*` file is out of date vs code

### Docs Sync inputs
- latest merged diff
- verification report
- acceptance checklist status
- decisions made during run

### Docs Sync output
- updated docs
- “what changed” summary
- “docs coverage” report

---

## Final reviewer / synthesizer node (recommended)

If you want consistently high docs quality, define a dedicated reviewer node:

- Role: `doc_reviewer`
- Provider: strongest doc model available (e.g., GPT-5.2 Pro via API)
- Trigger: `on_all_inputs` (after docs drafts + code changes)

### Output contract
The reviewer MUST output structured results:

- `doc_changes[]`: patches to apply
- `contradictions[]`: { files, description, suggested_fix }
- `missing_sections[]`
- `acceptance_gaps[]`

This lets the orchestrator enforce docs quality as a gate.

---

## Related docs

- `docs/21-context-packs.md`
- `docs/20-loop-safety-and-nonprogress.md`
