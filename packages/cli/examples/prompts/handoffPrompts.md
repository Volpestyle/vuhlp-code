
## Investigation -> Implementation handoff prompt
### Scenario: Aligning code to a spec investigation

  Remaining spec gaps (ordered by severity)
  - Critical: Planning/Implementation mode is not enforced (globalMode unused), so docs-only write restrictions and planning-time
    verification behavior don’t exist. docs/01-quickstart.md docs/02-concepts.md docs/04-orchestration-patterns.md apps/daemon/src/
    core/orchestrator.ts apps/daemon/src/core/types.ts
  - Critical: Docs-first lifecycle (DocContract gate + docs iteration before implementation) isn’t wired into the run loop; the
    phase helpers are defined but never invoked. docs/04-orchestration-patterns.md apps/daemon/src/core/orchestrator.ts
  - High: Auto-mode looping for standalone nodes and tick-based continuation aren’t implemented; the scheduler polls but no tick
    payloads are built/consumed, and root nodes only run once without upstream input. docs/01-quickstart.md docs/02-concepts.md
    apps/daemon/src/core/orchestrator.ts apps/daemon/src/core/tickEmitter.ts
  - High: Max iterations/time/token budget controls aren’t enforced; runs never transition to DONE automatically. docs/02-
    concepts.md apps/daemon/src/core/orchestrator.ts
  - High: JoinGate semantics beyond “all inputs ready” (merge artifacts, routing outcomes) are not implemented. docs/04-
    orchestration-patterns.md apps/daemon/src/core/orchestrator.ts
  - Medium: Debounce delivery policy is implemented as queue (no quiet-period behavior). docs/02-concepts.md apps/daemon/src/core/
    orchestrator.ts
  - Medium: Config spec drift (defaultProvider, node.maxTurnsPerLoop, node.defaultMode, planning.docsDirectory) isn’t represented
    in schema/loader. docs/10-config.md docs/05-provider-adapters.md docs/schemas/config.schema.json apps/daemon/src/config.ts
  - Low: Provider health checks don’t validate auth readiness (docs suggest ping-style checks). docs/06-auth.md apps/daemon/src/
    providers/codexCli.ts apps/daemon/src/providers/claudeCli.ts apps/daemon/src/providers/geminiCli.ts
    
  Docs conflict to resolve
  - docs/implementation_alignment.md says auto nodes re-run the initial prompt, while docs/02-concepts.md describes tick-based
    continuation. Current behavior is neither (no ticks; no re-run). We should pick one behavior and align code + docs.

  Tests not run.

Can you:

  1. Implement Planning/Implementation gating + docs-first lifecycle wiring.
  2. Implement tick-based auto loop + max-iterations enforcement.
  3. Reconcile config/docs drift (add config fields or update docs to match current behavior).

### Implementer review step: response:

  › i just implemented 1, 2, 3, can u check?

### Reviewer response:

Findings

  - Critical: Planning/Implementation gating is effectively disabled because globalMode is never set on runs; both the planning
    preamble and the implementation PLAN.md gate won’t ever trigger. apps/daemon/src/core/orchestrator.ts:1743 apps/daemon/src/
    core/orchestrator.ts:1902 apps/daemon/src/core/store.ts:95 apps/daemon/src/index.ts:123
  - Critical: Tick-based auto loop still stalls after the first run for standalone nodes; canScheduleNode returns false once a node
    has run, so the re-queued node never schedules. apps/daemon/src/core/orchestrator.ts:412 apps/daemon/src/core/
    orchestrator.ts:1801
  - High: maxIterations now counts every node execution (not loop iterations), so multi-node graphs stop after a few turns; when it
    trips, the run is aborted without updating run status, leaving state as “running”. apps/daemon/src/core/orchestrator.ts:1716
    apps/daemon/src/core/orchestrator.ts:159
  - High: Planning-mode verification still runs real commands; there’s no plan-completeness verification path. apps/daemon/src/
    core/orchestrator.ts:2186
  - Medium: Config drift isn’t fully resolved—new fields are added but not in schema, and naming doesn’t match docs (node_defaults
    + "manual" vs node.defaultMode "interactive"). apps/daemon/src/config.ts:7 apps/daemon/src/config.ts:13 docs/schemas/
    config.schema.json:1 docs/10-config.md:57
  - Medium: planning.docsDirectory is defined but docs inventory and plan writing still hard-code docs/. apps/daemon/src/
    config.ts:55 apps/daemon/src/core/orchestrator.ts:638
  - Low: New as any casts in the graph UI violate the TypeScript constraints and weaken type safety. packages/ui/src/components/
    GraphPane/GraphPane.tsx:1003 packages/ui/src/components/GraphPane/GraphPane.tsx:1040

  Questions

  - Do you want globalMode on POST /api/runs (defaulting to Implementation) and persisted in RunRecord, or a separate endpoint for
    toggling it?
  - Should maxIterations track loop iterations (per node loop) rather than total node executions?
  - Should planning.docsDirectory fully replace hard-coded docs/ in inventory + doc write paths?

  Change summary

  - Scheduler concurrency + verification wiring + docs-first gating were added in apps/daemon/src/core/orchestrator.ts.
  - New config fields were introduced in apps/daemon/src/config.ts, but they aren’t wired into schema or usage.

  Tests not run.

  If you want, I can propose concrete fixes for the critical issues in apps/daemon/src/core/orchestrator.ts and wire globalMode
  into the API/state.

### Implementer review step: response:
› ok i implemented a bunch of fixes for this, can u verify?

### Reviewer response:
• Reviewed the latest fixes for planning/implementation gating, auto-looping, and config alignment. Here are the remaining issues I
  found.

  Findings

  - High: globalMode now defaults to PLANNING and POST /api/runs accepts any value; docs still say Implementation is the default,
    so runs can start in the wrong mode and store invalid values. apps/daemon/src/core/store.ts:104 apps/daemon/src/index.ts:123
    docs/implementation_alignment.md:44
  - High: /api/runs/:runId/global-mode persists without emitting a run update event, so WS clients won’t reflect the mode change
    until reload. apps/daemon/src/index.ts:814
  - High: Router rules won’t match real payloads—payload.status is never set and artifacts are always { type: "ref" }, so
    on_success matches everything and on_artifact filters don’t work. apps/daemon/src/core/orchestrator.ts:2396 apps/daemon/src/
    core/orchestrator.ts:2405 apps/daemon/src/core/orchestrator.ts:548
  - Medium: Join gate ignores joinPolicy (quorum/wait_for) and simply aggregates whatever arrives when scheduled, so join semantics
    aren’t enforced. apps/daemon/src/core/types.ts:302 apps/daemon/src/core/orchestrator.ts:2447
  - Medium: planning.docsDirectory is only partially applied; repo facts + planning artifact writes still hard-code docs, so non-
    docs directories misreport and write to the wrong path. apps/daemon/src/core/orchestrator.ts:698 apps/daemon/src/core/
    orchestrator.ts:2725
  - Medium: Config drift remains—defaultProvider/node_defaults are not wired, and the schema doesn’t include the new keys, so
    configs validate but won’t apply. apps/daemon/src/config.ts:7 apps/daemon/src/index.ts:983 docs/schemas/config.schema.json:1

  Questions

  - Should global mode default to Implementation (per docs) or should we update the docs to match PLANNING-by-default?
  - For routing, do you want success/failure encoded in payload.status or should the router read from payload.structured.ok (e.g.,
    verification reports)?

  Tests not run.

  If you want, I can propose a patch set to fix the router/join semantics and finish the docsDirectory + config/schema wiring.