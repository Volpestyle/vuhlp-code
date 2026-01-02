# Agent Instructions (AGENTS.md)

This file is read by coding agents and humans to understand how to work in this repo.

## Goals
- Keep the harness **local-first** with a daemon (`agentd`) and a thin client (`agentctl`).
- Prefer **spec-driven development**. Specs live in `specs/<name>/spec.md`.
- Keep changes small and testable. Always run `make test` before finalizing.

## Repo layout
- `cmd/agentd` — daemon HTTP API + run coordinator (Python/FastAPI)
- `cmd/agentctl` — CLI client (Python)
- `internal/*` — harness implementation details
- `ai-kit` — integrated via local Python packages at `../ai-kit/packages/python` and `../ai-kit/packages/python-inference`

## Build & test
```bash
make build
make test
```

## Lint
```bash
make fmt
make vet
```

## Diagrams
Sources live in:
- `docs/diagrams/*.mmd` (Mermaid)
- `docs/diagrams/*.dac` (AWS diagram-as-code)

Rendered PNGs are committed:
- `docs/diagrams/*.png`

Render locally:
```bash
make diagrams
```

## Safety rules
- Never run destructive commands (e.g. `rm -rf`, `terraform apply`, `cdk deploy`) without an explicit approval gate.
- Do not print secrets into logs, events, or artifacts.
- Prefer read-only AWS operations (describe/list) unless the user approves changes.

## HTTP API
See: `docs/http-api.md`.

## Release checklist
- `make test`
- `make diagrams`
- update `docs/architecture.md` if behavior changes
