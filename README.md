# Coding Agent Harness (monorepo)

A **local-first**, spec-driven coding agent harness designed for:
- working against a **local filesystem + git repo**
- **efficient context gathering** (repo map + targeted file excerpts)
- **diagram-first docs** (Mermaid + AWS diagrams exported as PNG and embedded into Markdown)
- an **agent daemon + CLI** model so you can *peek/pilot* runs from another device (e.g. iPhone via Tailscale/Cloudflare Tunnel)

This repo integrates the real `ai-kit` Go module and uses a local `replace` to `../ai-kit/packages/go` during development. For production builds, drop the `replace` directive to pull from GitHub.

---

## What's included

- `cmd/agentd` — local daemon that runs jobs and exposes a small HTTP API + SSE event stream
- `cmd/agentctl` — CLI client for `agentd` (init/spec/run/attach/approve/export/list/doctor)
- `internal/agent` — step-based agent runtime (plan → execute w/ approvals → verify → docs)
- `internal/runstore` — persistent run store with an append-only NDJSON event log + live subscriptions
- `ai-kit` — provider-agnostic model registry + generation via the real Go module

---

## Quick start (local)

### 1) Build
```bash
make build
```

### 2) Start the daemon
```bash
./bin/agentd --listen 127.0.0.1:8787
```

Open the dashboard:
- http://127.0.0.1:8787/

### 3) Initialize a repo (creates AGENTS.md, docs/diagrams, scripts, etc.)
From any git repo you want to run the agent against:
```bash
/path/to/agentctl init
```

### 4) Create a spec
```bash
/path/to/agentctl spec new my-feature
```

### 5) Run the harness
```bash
/path/to/agentctl run --workspace . --spec specs/my-feature/spec.md
```

### 6) Attach to the run (live events)
```bash
/path/to/agentctl attach <run_id>
```

### 7) Approve gated steps
Some actions (shell commands, infra steps) are **approval-gated**. When the run requests approval:
```bash
/path/to/agentctl approve <run_id> --step <step_id>
```

---

## Diagrams (Mermaid + AWS)

This repo stores diagram sources next to exported PNGs.

- Mermaid: `docs/diagrams/*.mmd` → `docs/diagrams/*.png`
- AWS diagram-as-code: `docs/diagrams/*.dac` → `docs/diagrams/*.png`

Render them locally:
```bash
make diagrams
```

If you don't have the required tools installed, the scripts will print a helpful message.

---

## Remote cockpit (iPhone / another device)

`agentd` is local-first and binds to `127.0.0.1` by default.

To access the dashboard/API from another device, use a secure tunnel such as:
- Tailscale (Serve/Funnel)
- Cloudflare Tunnel

See: `docs/remote-cockpit.md` and `docs/security.md` for recommended patterns.

---

## Configuration

`agentd` reads config from flags and environment variables. Common env vars:

- `HARNESS_DATA_DIR` — where run data is stored (default: `~/.agent-harness`)
- `HARNESS_AUTH_TOKEN` — if set, **all API requests must** include `Authorization: Bearer <token>`
- Provider keys for ai-kit (e.g. `OPENAI_API_KEY`)

---

## License

MIT (see `LICENSE`).
