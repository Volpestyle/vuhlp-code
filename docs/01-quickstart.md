# Quickstart

## Prerequisites

Install at least one provider CLI locally (optional if using API transport):

### Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude --version
claude auth login
```

### OpenAI Codex

```bash
npm install -g @openai/codex
codex --version
export OPENAI_API_KEY=sk-...
```

### Google Gemini

```bash
npm install -g @google/gemini-cli
gemini --version
gemini auth login
```

---

## 1) Install dependencies

From the repo root:

```bash
pnpm install
```

---

## 2) Configure providers (env-based)

Vuhlp reads environment variables (and auto-loads `.env` from the repo root or parent dirs).

Start with `.env.example`:

```bash
cp .env.example .env
```

Edit `.env` for your providers. Example (CLI mode):

```bash
VUHLP_CLAUDE_TRANSPORT=cli
VUHLP_CODEX_TRANSPORT=cli
VUHLP_GEMINI_TRANSPORT=cli
```

For API mode, set per-provider API keys + model:

```bash
VUHLP_CLAUDE_TRANSPORT=api
VUHLP_CLAUDE_API_KEY=...
VUHLP_CLAUDE_MODEL=claude-3-5-sonnet-latest
```

See [docs/10-config.md](10-config.md) for the full env list.

---

## 3) Build local CLI forks (if using CLI mode)

Codex (local fork):

```bash
pnpm build:codex-cli
```

Gemini (local fork):

```bash
pnpm build:gemini-cli
```

---

## 4) Start the daemon

```bash
pnpm dev
```

Daemon defaults:
- HTTP: http://localhost:4000
- WebSocket: ws://localhost:4000/ws

---

## 5) Start the UI (dev)

```bash
pnpm --filter @vuhlp/ui dev
```

Open the UI at http://localhost:5173

---

## 6) Create a run

Create a run via UI, or call the API directly:

```bash
curl -s -X POST http://localhost:4000/api/runs \
  -H "content-type: application/json" \
  -d '{
    "mode": "INTERACTIVE",
    "globalMode": "PLANNING",
    "cwd": "."
  }'
```

Then add nodes (via the UI) to start provider sessions.

---

## Next steps

- [docs/02-concepts.md](02-concepts.md)
- [docs/03-architecture.md](03-architecture.md)
- [docs/12-api.md](12-api.md)
