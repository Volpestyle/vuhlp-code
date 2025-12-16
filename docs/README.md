# Forge CLI Docs Bundle

This `/docs` folder is a self-contained documentation bundle for **Forge CLI** — a terminal-based, agentic coding harness (written in Go) designed for **pnpm monorepos** with **docs-as-contract** rules, **Mermaid → PNG** diagrams, **AWS serverless** infra, and **`.env.prod` sync** via `pnpm sync:prod`.

## Contents

- `design/forge-cli-design.md` — full design doc (architecture, commands, config, policies, workflows).
- `schemas/plan.schema.json` — strict JSON Schema for the **Plan** output.
- `schemas/verify.schema.json` — strict JSON Schema for the **Verify** output.
- `prompts/plan_system.md` — default system prompt for **Plan** (docs-as-contract).
- `prompts/patch_system.md` — default system prompt for **Patch** (diff-only).
- `prompts/verify_system.md` — default system prompt for **Verify** (docs alignment + policy checks).
- `ci/policy-checks.md` — CI-ready policy checks with clear failure messages.
- `ci/github-actions-example.yml` — example workflow wiring `forge verify` into GitHub Actions.
- `config/forge.example.yaml` — example Forge configuration.
- `examples/` — sample plan + verify JSON and a sample diff.

## Diagram rendering

Some docs include Mermaid diagrams and reference PNG outputs under `assets/diagrams/`.
In this bundle the PNGs are **placeholders**. In a real repo you would generate them with your own renderer pipeline, e.g.:

- `forge docs render`
- or a repo script like `pnpm docs:render`
