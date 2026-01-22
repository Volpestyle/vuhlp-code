# Configuration

Vuhlp is configured entirely via environment variables. The daemon auto-loads a `.env` file from the current working directory (and up to 4 parent levels).

## Core environment variables

- `VUHLP_BIND_HOST` / `VUHLP_HOST`: bind host (default `0.0.0.0`)
- `VUHLP_PORT`: HTTP/WS port (default `4000`)
- `VUHLP_DATA_DIR`: data directory (default `data`)
- `VUHLP_REPO_ROOT`: repo root for tool execution (default `process.cwd()`)
- `VUHLP_APP_ROOT`: vuhlp app root (default derived from `packages/daemon`)
- `VUHLP_STALL_THRESHOLD`: stall detection threshold (default `20`)

## Provider configuration

Set per-provider transport:

- `VUHLP_<PROVIDER>_TRANSPORT=cli|api`

Supported providers: `CLAUDE`, `CODEX`, `GEMINI`, `CUSTOM`.

### CLI transport

- `VUHLP_<PROVIDER>_COMMAND`
- `VUHLP_<PROVIDER>_ARGS`
- `VUHLP_<PROVIDER>_PROTOCOL` (raw/stream-json/jsonl; Claude/Codex are forced)
- `VUHLP_<PROVIDER>_STATEFUL_STREAMING` (ignored for Claude/Codex)
- `VUHLP_<PROVIDER>_RESUME_ARGS`
- `VUHLP_<PROVIDER>_REPLAY_TURNS`
- `VUHLP_<PROVIDER>_NATIVE_TOOLS=provider|vuhlp`

### API transport

- `VUHLP_<PROVIDER>_API_KEY`
- `VUHLP_<PROVIDER>_API_URL`
- `VUHLP_<PROVIDER>_MODEL`
- `VUHLP_<PROVIDER>_MAX_TOKENS`

## Defaults and enforcement

- Claude CLI is forced to stream-json input/output.
- Codex CLI runs the local fork (`codex vuhlp`) with jsonl protocol.
- Gemini CLI defaults to stream-json input/output and uses the local bundle when available.

## Example (.env)

```bash
VUHLP_PORT=4000
VUHLP_DATA_DIR=data

VUHLP_CLAUDE_TRANSPORT=cli
VUHLP_CODEX_TRANSPORT=cli
VUHLP_GEMINI_TRANSPORT=cli
```

See `.env.example` for a full template.
