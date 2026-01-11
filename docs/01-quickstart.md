# Quickstart

## 1) Install dependencies

```bash
cd apps/daemon
npm install
```

## 2) Start the daemon + UI

```bash
npm run dev
```

This starts:

- HTTP server: `http://localhost:4317`
- WebSocket: `ws://localhost:4317/ws`

## 3) Create a run

Open the UI and click:

- **New Run**
- Choose provider: **Mock** (works without any external CLIs)
- Paste a prompt (e.g. “Add a hello endpoint, add tests, run verification”)

You will see nodes appear in the graph:

- investigation → plan → implement → verify → (loop if needed)

## 4) Enable Codex / Claude / Gemini

v0 supports spawning CLIs, but you must have them installed.

1. Install and authenticate:
   - Codex CLI (`codex`)
   - Claude Code (`claude`)
   - Gemini CLI (`gemini`)
2. Update `apps/daemon/vuhlp.config.json`

See:
- `docs/05-provider-adapters.md`
- `docs/06-auth.md`

## 5) Run against a repository

For safety, v0 defaults to **shared workspace** (no automatic worktrees).
To enable isolated workspaces, set:

```json
{
  "workspace": {
    "mode": "worktree"
  }
}
```

See `docs/07-workspaces.md`.
