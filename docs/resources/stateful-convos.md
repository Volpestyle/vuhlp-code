Yes — the streaming approach works for stateful conversations, but how you make it stateful depends on the CLI, and there are basically two sane architectures:

Option A (best): keep a CLI process alive per session (true statefulness)

You spawn one CLI process per chat session, keep its stdin/stdout open, and stream events back to the client over WebSocket (or HTTP/2 streaming). Each user message is written to stdin; stdout yields progressive events you forward.

Pros
	•	Real “chat” feel (no rehydration lag)
	•	Preserves the CLI’s internal state exactly (tools, working directory, memory, etc.)
	•	Streaming is easiest: just pipe stdout continuously

Cons
	•	You’re now running a session manager (timeouts, limits, cleanup)
	•	WebSockets are usually required for multi-turn interactivity

Vuhlp note:
- stream-json/jsonl CLIs are stateful by default (resume + replay); set `VUHLP_<PROVIDER>_STATEFUL_STREAMING=0` to force stateless execution (not supported for Claude or Codex CLI).
- Claude CLI uses stream-json input by default, so stdin stays open between turns.
- Codex CLI uses jsonl input via the local fork (`codex vuhlp`), so stdin stays open between turns.
- stream-json stdin is closed after each prompt for other CLIs unless they support multiple prompts on stdin. This avoids hangs for CLIs that wait on EOF.
- True long-lived stdin sessions require a CLI (or wrapper) that accepts multi-turn stdin (jsonl-compatible) and emits an explicit turn boundary (e.g., `message_end`/`message_stop` or `message.assistant.final`).
- The `raw` protocol remains one-shot.
- On disconnect, vuhlp forces a full prompt and (when resume args are unset) replays the last N turns (default 4, override with `VUHLP_<PROVIDER>_REPLAY_TURNS`).

When to choose it: if you want the user to keep chatting for minutes/hours and the agent might run tools / browse repo / maintain working state.

⸻

Option B (simpler): stateless HTTP per turn + “resume/continue” via session IDs

Each user turn is a new HTTP request:
	1.	Backend runs CLI --resume <session> (or “continue most recent”)
	2.	You pass the new prompt
	3.	Stream NDJSON back
	4.	Process exits

Vuhlp note:
- Use `VUHLP_<PROVIDER>_RESUME_ARGS="--continue"` (or provider-specific flags) to enable per-turn resume.
- If `VUHLP_<PROVIDER>_RESUME_ARGS` is unset, vuhlp runs without resume args.
- Claude CLI stream-json stdin mode ignores resume args (the process stays alive instead).
- Optional fallback: set `VUHLP_<PROVIDER>_REPLAY_TURNS` to replay the last N turns into the prompt when resume args are unset.

This is still stateful as long as the CLI supports resuming the same conversation thread.

Codex CLI

Vuhlp uses the local Codex fork in `${VUHLP_APP_ROOT}/packages/providers/codex` and runs `codex vuhlp` (JSONL stdin/stdout). This keeps stdin open for true stateful sessions.
Upstream `codex exec --json` remains one-shot and is not used by vuhlp.

Claude Code

Claude Code headless docs indicate you can run programmatically and include flags like --continue for continuing conversations.  ￼
Caveat: there have been versions where --resume behavior was buggy/ignored, so you should test on your installed version.  ￼

Gemini CLI

Upstream Gemini CLI does not expose a stream-json input format; expect one-shot turns with resume support. vuhlp passes `--input-format stream-json` by default, so you must use a fork that supports stream-json stdin (point `VUHLP_GEMINI_COMMAND` to that local binary) or switch to API transport. Add `--core-tools none` if you want Gemini CLI to disable native tools; omit it to let Gemini CLI run its native tools while vuhlp observes tool_use/tool_result events.

Gemini stream-json stdin (fork)
	•	{"type":"message","role":"user","content":"...","turn_id":"optional"}
	•	{"type":"session.end","reason":"optional"}

Pros
	•	Much easier infra than long-lived processes
	•	Works fine with your NDJSON streaming endpoint design

Cons
	•	Resume/continue fidelity depends on CLI implementation
	•	Can be slower per turn
	•	If the CLI’s “state” includes local tool side-effects, you must ensure you resume in the same workspace/dir/container

⸻

What I’d implement for your RN + Web app

If you want “chat with an agent in a repo” (Claude Code / Codex style):

Do Option A:
	•	WebSocket /ws/session/:id
	•	Backend creates a session container + spawns CLI once
	•	Stream stdout events to clients
	•	Write user messages into stdin
	•	Kill session after inactivity

If you want “LLM chat only” with minimal tool usage:

Do Option B:
	•	POST /api/turn { sessionId, provider, prompt }
	•	Backend runs resume/continue, streams NDJSON, exits
	•	Store sessionId on the client

⸻

Important detail: “stateful” means two different things
	1.	Conversation memory (prior messages)
	2.	Agent runtime state (cwd, file edits, tool results, caches)

Option B can preserve (1) pretty reliably if the CLI supports it.
Option A preserves both (1) and (2) because you keep the process alive.

⸻

Minimal “stateful over HTTP” contract (works across clients)

Have your backend return a sessionId early in the stream:

{"type":"session","sessionId":"abc123"}
{"type":"delta","text":"Hello"}
...
{"type":"done"}

Then client sends it next turn:

{ "sessionId":"abc123", "provider":"codex", "prompt":"ok now refactor it" }


⸻

If you tell me which mode you’re targeting:
	•	“agent editing a repo” vs “chat only”
	•	and whether you need tool approvals from the UI

…I’ll sketch the exact session manager shape (WS vs HTTP), and the per-provider commands + event-to-delta extraction you should standardize on.
