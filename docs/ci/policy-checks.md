# CI Policy Checks for Forge CLI

This document describes a **recommended CI policy suite** for repos using Forge.

> Principle: prefer a single entrypoint: `forge verify --mode=ci`  
> Internally it may run multiple checks/commands, but CI stays simple.

---

## 1) The one CI command

```bash
forge verify --mode=ci
```

This should:
- run repo verification commands (lint/typecheck/test)
- run docs checks (if docs touched)
- run infra synth (if infra touched)
- enforce env sync gate (if `.env.prod` touched)
- enforce README-per-package policy

---

## 2) Policy checks and clear failure messages

### 2.1 Docs-as-contract (plan citations)

**What it checks**
- Any LLM-assisted change must have a Plan with doc citations (`path + heading`).
- In CI, you generally run `forge verify` on the resulting branch; this check is most relevant for `forge run` artifacts and PR templates.

**Failure message**
- `FORGE_DOCS_CONTRACT: Missing doc citations in plan.json (docs-as-contract enabled). Provide --spec or add docs under /docs.`

---

### 2.2 Forbidden paths touched

**What it checks**
- `.env*`, `**/secrets/**`, `**/*.pem`, `**/*.key`, etc.

**Failure message**
- `FORGE_FORBIDDEN_PATH: Patch touches forbidden path(s): <paths>. Remove changes to secret-bearing files.`

---

### 2.3 `.env.prod` sync gate

**What it checks**
- If `.env.prod` changed compared to base ref, the sync marker must be updated by a successful `forge env sync prod` (which runs `pnpm sync:prod`).

**Failure message**
- `FORGE_ENV_SYNC_REQUIRED: .env.prod changed but was not synced. Run: forge env sync prod (or pnpm sync:prod) and commit the updated marker.`

**Notes**
- The marker file should be committed (recommended) so CI can verify it:
  - `.forge/state/env_prod.sha256`

---

### 2.4 README per package

**What it checks**
- Every package directory under `packages/*` contains a `README.md`.
- Optionally, only enforce for packages changed in the PR (configurable).

**Failure message**
- `FORGE_README_MISSING: Missing README.md in package(s): <pkg1>, <pkg2>. Create README.md or update policy configuration.`

---

### 2.5 Mermaid → PNG diagram hygiene

**What it checks**
- If docs contain Mermaid diagrams, referenced PNG outputs must exist (and optionally be up to date).

**Failure message**
- `FORGE_DOCS_DIAGRAMS: Mermaid diagrams changed but PNG outputs are missing/out-of-date. Run: forge docs render (or pnpm docs:render) and commit outputs.`

---

### 2.6 Infra synth on infra changes

**What it checks**
- If infra files changed (configurable patterns), run synth/package:
  - CDK preset: `pnpm -C infra cdk:synth`

**Failure message**
- `FORGE_INFRA_SYNTH_FAILED: Infra synth failed. Fix IaC errors or update synth command in forge.yaml.`

---

### 2.7 Repo verification commands

Recommended default commands:
- `pnpm -r lint`
- `pnpm -r typecheck`
- `pnpm -r test`

**Failure message**
- `FORGE_VERIFY_FAILED: Verification command failed: <command>. See logs above for details.`

---

## 3) Suggested GitHub Actions integration

See: `ci/github-actions-example.yml`

---

## 4) Suggested local hooks

Optional: add `forge verify --mode=ci` as a pre-push hook.

> Keep hooks fast; you can also provide a "quick" verify mode if needed.
