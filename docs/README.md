# vuhlp docs

These docs are the source of truth for the current implementation in `packages/daemon` and `packages/ui`.

## Doc order
1. [docs/00-shared-contract.md](00-shared-contract.md)
2. [docs/01-product-spec.md](01-product-spec.md)
3. [docs/02-prompts-and-templates.md](02-prompts-and-templates.md)
4. [docs/03-agent-parameters-and-permissions.md](03-agent-parameters-and-permissions.md)
5. [docs/04-communication-and-context.md](04-communication-and-context.md)
6. [docs/05-graph-rules-and-scheduling.md](05-graph-rules-and-scheduling.md)
7. [docs/06-orchestration-modes-and-loop-safety.md](06-orchestration-modes-and-loop-safety.md)
8. [docs/07-ui-spec.md](07-ui-spec.md)
9. [docs/08-stack.md](08-stack.md)
10. [docs/09-ui-graph.md](09-ui-graph.md)
11. [docs/10-config.md](10-config.md)
12. [docs/12-api.md](12-api.md)

## Role templates
- Repo overrides (optional): [docs/templates/<template>.md](templates/)
- System defaults: [packages/daemon/docs/templates/<template>.md](../packages/daemon/docs/templates/)

## Notes
- Local-first only: no cloud or multi-tenant concerns.
- Event logs and artifacts are stored under the configured `dataDir` (default `data`).
- Prompts, tool events, and artifacts are logged for auditability.
