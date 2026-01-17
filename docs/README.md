# vuhlp docs v2

This folder is the source‑of‑truth spec for rebuilding the application from scratch with improved behavior and clarity.

## Doc order
1. `docs/00-shared-contract.md`
2. `docs/01-product-spec.md`
3. `docs/02-prompts-and-templates.md`
4. `docs/03-agent-parameters-and-permissions.md`
5. `docs/04-communication-and-context.md`
6. `docs/05-graph-rules-and-scheduling.md`
7. `docs/06-orchestration-modes-and-loop-safety.md`
8. `docs/07-ui-spec.md`
9. `docs/08-stack.md`

## Templates
- `docs/templates/orchestrator.md`
- `docs/templates/planner.md`
- `docs/templates/implementer.md`
- `docs/templates/reviewer.md`
- `docs/templates/investigator.md`

## Notes
- v2 is a redesign: improved behavior is specified even if v0 is different.
- Local‑first only: no cloud or multi‑tenant concerns.
- Full visibility is mandatory: prompts, diffs, and events must be logged.
