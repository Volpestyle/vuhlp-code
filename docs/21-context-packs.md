# Context Packs

Context is the primary lever for:

- autonomy (agents can act without asking)
- accuracy (fewer hallucinated assumptions)
- efficiency (lower token usage)
- debuggability (why did the agent do that?)

vuhlp should NOT pass entire transcripts or entire repositories to every node.

Instead, vuhlp uses a **Context Pack**: a compact, structured bundle of the *minimum necessary* context for a node to do high-quality work.

---

## What a Context Pack is

A **Context Pack** is a JSON object that can be:

- attached to a node turn as input
- forwarded across edges
- merged by JoinGate
- stored as an artifact for replay/debugging

Schema:
- `docs/schemas/context-pack.schema.json`

---

## Design goals

A Context Pack MUST:

1) Be **small and scoped** (token-budgeted).
2) Prefer **docs as source of truth** over memory.
3) Carry **provenance** (what came from where).
4) Be **portable** across providers (Codex / Claude / Gemini).
5) Support **deterministic reconstruction** (replay).

---

## Canonical fields

These fields are recommended for every pack:

### Identity
- `packId` (UUID)
- `runId`
- `nodeId`
- `createdAt`

### Objective
- `goal`: the node’s objective in 1–3 sentences
- `definitionOfDone`: checklist of completion conditions

### Workflow mode
- `globalMode`: `planning | implementation`
- `nodeMode`: `auto | interactive`

### Docs as contract
- `docsRoot`: default `/docs`
- `docRefs[]`: references to authoritative docs sections
  - `{ path, anchors?, excerpt?, priority }`

### Repo facts
- `repoFacts`: language/tooling summary
- `workspace`: `{ mode, rootPath, worktreePath?, branch? }`

### Relevant files
- `relevantFiles[]`:
  - `{ path, purpose, excerpt?, hash? }`

### Prior results
- `inputs[]`: upstream payload refs
- `artifacts[]`: logs, diffs, reports to consider
- `decisions[]`: stable decisions made so far

### Constraints and policy
- `constraints`: e.g., no new deps, style, API compatibility
- `toolPolicy`: allowed/blocked tools, approval mode

### Output contract
- `outputSchemaRef`: pointer to expected JSON schema or contract

---

## How packs are constructed (SOTA approach)

The current best practice for multi-agent coding workflows is a **three-layer memory system**:

1) **Provider-native session continuity**
   - Continue/resume the same session when possible.
2) **Event-sourced run log**
   - Everything important is stored as events + artifacts.
3) **Curated context packs**
   - Only the most relevant information is injected each turn.

vuhlp implements (3) with a deterministic builder.

### Context Pack Builder algorithm (recommended)

1) **Start from docs contract**
   - Load the top-priority docRefs (Plan + Acceptance + Architecture).
2) **Attach only deltas**
   - Add “what changed since last turn” (tests, diffs, new errors).
3) **Select relevant files**
   - Use:
     - dependency graph heuristics (imports)
     - grep/search results
     - file ownership metadata
4) **Trim aggressively**
   - Apply a token budget.
   - Prefer summaries over raw logs.
5) **Redact secrets**
   - Remove keys, tokens, credentials.
6) **Emit pack + provenance**

---

## Passing context between nodes

Edges SHOULD forward:

- a payload envelope (see `edge-payload.schema.json`)
- plus a `contextPackRef` (artifact reference)

This keeps payloads small while allowing downstream nodes to load the full pack on demand.

Recommended rule:
- **Downstream nodes receive references, not huge embedded data.**

---

## Token budgeting guidance

Rule of thumb:

- Keep context packs under **2–6k tokens** for routine turns.
- Allow larger packs (10–20k) only for:
  - initial investigation
  - large refactors
  - deep verification failures

Always include:
- objective
- definition of done
- docs references
- the minimal error/failure evidence required

---

## Example

See:
- `docs/examples/context-pack.sample.json`

---

## Related docs

- `docs/18-execution-semantics.md`
- `docs/22-docs-lifecycle.md`
