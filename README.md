# vuhlp code (v0)

A **local-first coding-agent orchestration harness** that coordinates **Codex**, **Claude Code**, and **Gemini CLI** as worker agents, with a **live graph UI** showing handoffs and agent progress.

> **Status:** v0 is an MVP-style implementation focused on the core orchestration loop, event model, provider adapters (best-effort), and visualization.

## What’s inside

- `apps/daemon/` — Node.js daemon that:
  - runs orchestrations (“runs”)
  - spawns provider CLIs (Codex / Claude Code / Gemini) or a built-in mock provider
  - normalizes streaming output into a canonical event log
  - serves a web UI + WebSocket live updates
- `docs/` — extensive spec + architecture notes + schemas + roadmap

## Quickstart (mock provider)

**Requirements**
- Node.js 20+ (works with Node 22)
- macOS/Linux recommended

```bash
cd apps/daemon
npm install
npm run dev
```

Open: http://localhost:4317

In the UI, create a run using the **Mock** provider to see the orchestrator graph.

## Using Codex / Claude / Gemini

v0 includes adapters that spawn the CLIs, but expects you to have each CLI installed + authenticated locally.

See:
- `docs/05-provider-adapters.md`
- `docs/06-auth.md`

## Repo layout

```text
vuhlp-code/
  apps/
    daemon/
      src/
      static/
  docs/
```

## Notes

- v0 is intentionally **local-first** and delegates auth to the provider CLIs.
- “Thoughts” in the UI are represented as **reasoning summaries** + **observable actions** (commands, diffs, logs), not raw chain-of-thought.

---

### Future work

See `docs/11-roadmap.md` for v1/v2 plans (multi-orchestrator subgraphs, richer mapping of provider event streams, remote runners, policy packs, etc.).
