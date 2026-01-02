# Coding Agent Harness (monorepo)

A **local-first**, spec-driven coding agent harness designed for:
- working against a **local filesystem + git repo**
- **efficient context gathering** (repo map + targeted file excerpts)
- **diagram-first docs** (Mermaid + AWS diagrams exported as PNG and embedded into Markdown)
- an **agent daemon + CLI** model so you can *peek/pilot* runs from another device (e.g. iPhone via Tailscale/Cloudflare Tunnel)

This repo integrates the real `ai-kit` Python packages and uses local file dependencies to `../ai-kit/packages/python` and `../ai-kit/packages/python-inference` during development.

---

## What's included

- `cmd/agentd` — local daemon that runs jobs and exposes a small HTTP API + SSE event stream
- `cmd/agentctl` — CLI client for `agentd` (init/spec/run/attach/approve/export/list/doctor + sessions)
- `internal/agent` — step-based agent runtime (plan → execute w/ approvals → verify → docs)
- `internal/runstore` — persistent run store with an append-only NDJSON event log + live subscriptions
- `ai-kit` — provider-agnostic model registry + generation via the Python inference kit

---

## Quick start (local)

### 1) Install dependencies
```bash
python -m pip install -e .[dev]
```
Note: this repo expects the ai-kit packages to be available at `../ai-kit`. If you're using a published package instead, update `pyproject.toml`.
If your Python is externally managed (PEP 668), create a venv first:
```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -e .[dev]
```

### 2) Build wrappers
```bash
make build
```

### 3) Start the daemon
```bash
./bin/agentd --listen 127.0.0.1:8787
```

Open the dashboard:
- http://127.0.0.1:8787/

### 4) Initialize a repo (creates AGENTS.md, docs/diagrams, scripts, etc.)
From any git repo you want to run the agent against:
```bash
/path/to/agentctl init
```

### 5) Create a spec
```bash
/path/to/agentctl spec new my-feature
```

### 6) Run the harness
```bash
/path/to/agentctl run --workspace . --spec specs/my-feature/spec.md
```

### 7) Attach to the run (live events)
```bash
/path/to/agentctl attach <run_id>
```

### 8) Approve gated steps
Some actions (shell commands, infra steps) are **approval-gated**. When the run requests approval:
```bash
/path/to/agentctl approve --step <step_id> <run_id>
```

---

## Comprehensive walkthrough

This section covers all current features: spec-driven runs, chat sessions,
spec-session mode, approvals, exports, diagrams, and configuration.

### Build + start the daemon
```bash
make build
./bin/agentd --listen 127.0.0.1:8787
```

### Spec-driven runs (batch workflow)

1) Create a spec:
```bash
/path/to/agentctl spec new my-feature
```

2) Run the harness on a spec:
```bash
/path/to/agentctl run --workspace . --spec specs/my-feature/spec.md
```

3) Attach to the run event stream:
```bash
/path/to/agentctl attach <run_id>
```

4) Approve gated steps:
```bash
/path/to/agentctl approve --step <step_id> <run_id>
```

5) Export run artifacts:
```bash
/path/to/agentctl export --out /tmp/run.zip <run_id>
```

### Generate a spec from a prompt

```bash
/path/to/agentctl spec prompt \
  --prompt "Add a CLI command to ..." \
  --workspace . \
  my-feature
```

Use `--prompt-file` for longer prompts and `--overwrite` to replace an existing spec.

### Chat sessions (agentic loop)

1) Create a session:
```bash
/path/to/agentctl session new --workspace .
```

2) Send a message (auto-runs a turn):
```bash
/path/to/agentctl session message --text "Review the docs." <session_id>
```

3) Stream session events:
```bash
curl -N http://127.0.0.1:8787/v1/sessions/<session_id>/events
```

4) Approve tool calls:
```bash
/path/to/agentctl session approve --call <tool_call_id> <session_id>
```

### Spec-session mode (continuous spec iteration)

Create a session in spec mode and pass a spec path:
```bash
/path/to/agentctl session new --mode spec --spec specs/my-feature/spec.md --workspace .
```

Send prompts and the agent will auto-write `spec.md` and validate schema
headings on each update:
```bash
/path/to/agentctl session message --text "Add acceptance tests." <session_id>
```

Spec mode enforces headings:
- `# Goal`
- `# Constraints / nuances`
- `# Acceptance tests`

### Attachments (vision/audio/file context)

Upload an attachment and get a reference:
```bash
/path/to/agentctl session attach --file ./docs/ui.png <session_id>
```

Send a message that references it:
```bash
/path/to/agentctl session message --ref attachments/ui.png --mime image/png <session_id>
```

### Approvals (safety gates)

The agent gates writes/exec by default. Approvals are surfaced as events:
- Runs: `agentctl approve --step <step_id> <run_id>`
- Sessions: `agentctl session approve --call <tool_call_id> <session_id>`

### Notes on exports

Run exports are supported via `agentctl export`. Session export is stored in the
runstore but not exposed as a public API endpoint yet.

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

`agentd` also loads `.env.local` (and `.env`) from its working directory on startup.

---

### Model selection

Model routing is handled by ai-kit + a model policy. The harness resolves a
tool-capable model for runs and sessions (see `docs/ai-kit-integration.md`).

## License

MIT (see `LICENSE`).
