# Provider adapters (Codex / Claude / Gemini)

This design keeps adapters **thin** and “harness-respecting”.

Adapters are responsible for:

- building a provider command line for a single turn
- executing it inside the node’s tmux pane (managed turns)
- capturing logs + artifacts
- extracting session identifiers (if available)
- producing a normalized **Output Envelope**

---

## Common adapter interface (spec)

```
ensureInstalled() -> bool
ensureAuthenticated() -> AuthStatus

startSession(node) -> ProviderSessionInfo
runTurn(node, input) -> TurnResult (streamed logs + final envelope)
resumeSession(node, provider_session_id) -> ProviderSessionInfo
```

---

## Codex adapter

### Turn execution strategy
Preferred: `codex exec` with structured output.

For a single turn:
- `codex exec "<prompt>"` (human)
- optionally `--json` for machine parsing
- optionally `--output-schema <path>` for strict output

Session continuity:
- store thread/session id (if available)
- later turns use:
  - `codex exec resume <session_id> "<prompt>"`
  - or `codex exec --last "<prompt>"`

Safety:
- default to `--sandbox read-only` until user opts in.
- in AUTO, allow `workspace-write` for implementation nodes.

---

## Claude Code adapter

Turn execution strategy:
- `claude -p "<prompt>"` for headless
- use `--output-format stream-json` if you want streaming structured events
- use `--output-format json --json-schema ...` when you need validated output

Session continuity:
- store `session_id` from JSON output when available
- use `--resume <session_id>` or `--continue`

Safety:
- default to restricted `--allowedTools`
- in interactive mode, avoid auto-approving tools

---

## Gemini CLI adapter

Turn execution strategy:
- `gemini -p "<prompt>"`
- use `--output-format json` or `stream-json` if supported by installed version

Session continuity:
- capture session id if printed in JSON output
- use `--resume <session_id>` for follow-ups

Safety:
- default to safe approval mode
- allow tools only when needed

---

## Output envelope normalization

Every adapter must return:

- `summary` (1–3 sentences)
- `status` ok/error
- `artifacts` paths (logs, diffs, structured json)
- optional `structured` parsed JSON output

Even if parsing fails, produce an envelope with status=error and attach logs.

---

## Practical note: interactive REPL vs managed turns
Managed turns are easiest to orchestrate and most reliable for logging.
If you later add REPL mode:
- keep it manual-only
- do not use REPL sessions in AUTO scheduling initially

