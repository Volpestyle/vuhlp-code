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
- stream-json CLIs are stateless by default; set `VUHLP_<PROVIDER>_STATEFUL_STREAMING=1` to keep them alive between turns.
- This only works if the CLI accepts multiple prompts on stdin and emits `message_end`/`message_stop` per turn.
- The `raw` protocol remains one-shot.

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
- If `VUHLP_<PROVIDER>_RESUME_ARGS` is unset, vuhlp defaults to `--continue` for Claude and no resume args for other providers.
- Optional fallback: set `VUHLP_<PROVIDER>_REPLAY_TURNS` to replay the last N turns into the prompt when resume args are unset.

This is still stateful as long as the CLI supports resuming the same conversation thread.

Codex CLI

Codex explicitly supports resuming an interactive session: codex resume (by ID or “most recent”).  ￼

Claude Code

Claude Code headless docs indicate you can run programmatically and include flags like --continue for continuing conversations.  ￼
Caveat: there have been versions where --resume behavior was buggy/ignored, so you should test on your installed version.  ￼

Gemini CLI

Gemini CLI added automatic session management (Dec 2025), saving history and letting you resume later.  ￼
(There’s also community discussion/commands around session management.)  ￼

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
