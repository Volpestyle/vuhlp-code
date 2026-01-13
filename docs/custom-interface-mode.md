Below is the approach I’d use to implement “custom interface mode” so that:
• you get a fully instrumented, graph-native UI (nodes + handoffs + parallelism),
• you still get a Raw Console tab that looks like the CLI experience (or as close as possible),
• you maintain real, provider-native session continuity across turns (not “stateless one-shots”),
• and you reuse the default harnesses (Codex CLI, Claude Code CLI, Gemini CLI) as much as possible.

⸻

What “custom interface mode” should be

Think of it as dual-channel observability: 1. Structured event channel (primary)
You run each harness in a machine-readable streaming mode and parse events into a canonical event model.

    •	Codex: codex exec --json emits newline-delimited JSON events on stdout.  ￼
    •	Claude Code: claude -p --output-format stream-json emits newline-delimited JSON objects (streaming).  ￼
    •	Gemini CLI: gemini -p --output-format stream-json emits newline-delimited JSON events, including an init event with session_id.  ￼

    2.	Raw console channel (always-on fallback)

You always capture stdout/stderr as raw bytes (plus timestamps) and display it in a terminal-style viewer.

This guarantees: even if parsing fails or a provider changes event schema, you still have the “what actually happened” record.

⸻

Backend architecture that makes the UI possible

Core components

A. Provider adapters (Codex / Claude / Gemini)
Each adapter does the same 5 jobs: 1. Spawn the CLI process with the right flags 2. Capture stdout/stderr as raw console chunks 3. Parse structured events (JSONL / stream-json) 4. Normalize provider events into a canonical event bus 5. Return a “turn result” object (final assistant message + artifacts + metrics)

B. Event bus + event store (event-sourcing)
This is the key for the graph UI.
Instead of “saving final output,” you persist an append-only stream like:
• RunCreated, NodeCreated, NodeStarted
• NodeConsoleChunk
• AgentMessageDelta, ToolCallProposed, ToolCallExecuted
• ArtifactProduced
• ApprovalRequested, ApprovalResolved
• NodeCompleted, RunCompleted, ErrorRaised

Then the UI just subscribes and renders it.

C. Websocket/SSE streaming to UI
You want live visualization, so do not poll. Stream events down as they happen.

D. Session registry
Maps your internal conversation_id / node_id to provider-native session handles:
• Codex: thread_id (from JSON events) ￼
• Claude Code: session_id (from --output-format json)
• Gemini: session_id from the init stream-json event ￼

⸻

Provider-by-provider technical guidance (custom interface mode)

1. Codex CLI (OpenAI)

Best “custom UI” invocation
Use JSONL streaming:

codex exec --json \
 --sandbox read-only \
 --ask-for-approval never \
 "your prompt here"

    •	--json makes stdout a JSONL event stream (not plain text).  ￼
    •	Codex’s event stream includes things like thread.started, turn.started/completed, and item events; item types can include messages, reasoning, command executions, file changes, MCP tool calls, and web searches.  ￼
    •	For safety and “non-hanging runs,” avoid approval prompts in custom interface mode by using --ask-for-approval never. OpenAI explicitly documents that --ask-for-approval never disables prompts and works across sandbox modes.  ￼

Session continuity (turn-based, but still a real session)
From the JSON event stream you’ll get a thread_id on thread.started. ￼
To continue, use the resume flow:
• codex exec resume <SESSION_ID> "follow-up prompt"
• or resume the latest with --last ￼

In your session registry:
• store the thread_id as your provider_session_id
• on next turn, call codex exec resume <thread_id> ...

“Thoughts”
Codex JSON events can include a “reasoning” item type. Treat that as “Reasoning/Notes” in UI (don’t promise full hidden chain-of-thought; display what the harness emits). ￼

⸻

2. Claude Code (Anthropic)

Best “custom UI” invocation
Use print mode + stream-json:

claude -p \
 --output-format stream-json \
 --include-partial-messages \
 "your prompt here"

    •	-p runs non-interactively (headless)  ￼
    •	--output-format stream-json emits newline-delimited JSON objects for real-time streaming  ￼
    •	--include-partial-messages lets you show “typing/streaming deltas” (ideal for UI)  ￼

Session continuity
Claude Code supports:
• --continue to continue the most recent conversation
• --resume <session_id> to resume a specific conversation; session_id can be captured from JSON output.
• --session-id <uuid> if you want to set the session ID yourself (must be a UUID). ￼
• --fork-session to branch a session (this maps beautifully to your graph “fork node” UX). ￼

Recommended mapping for vuhlp:
• For each node, generate a UUID and use --session-id <uuid> so you always know the session identifier up front. ￼
• If you need “resume behavior,” use --resume <uuid> or --fork-session on retries/branching. ￼

Structured output (for verifier loops)
When you want the agent to return machine-validated results:

claude -p \
 --output-format json \
 --json-schema '{...}' \
 "produce structured result"

Claude Code docs state --output-format json includes session ID + metadata, and --json-schema puts validated structured output in structured_output. ￼

Tool approvals in a UI (critical)
You have two viable patterns:

Pattern A: allowlist tools per node
• Use --allowedTools to auto-approve specific tools (Bash, Read, Edit, etc.)
• Your UI exposes a “capabilities” toggle; backend maps that to --allowedTools.

Pattern B: interactive approvals routed to your orchestrator
• Use --permission-prompt-tool to specify an MCP tool that handles permission prompts in non-interactive mode. ￼
• This is the best match for a central approvals queue UX (see below).

⸻

3. Gemini CLI (Google)

Best “custom UI” invocation
Gemini’s headless mode supports streaming JSON events:

gemini -p "your prompt here" --output-format stream-json

The headless docs show stream-json output includes event types like init, message, tool_use, tool_result, error, and result—and the init event contains session_id. ￼

Session continuity
Gemini CLI has explicit session management:
• sessions are auto-saved per project and can include tool executions, token stats, and reasoning summaries ￼
• you can resume with --resume <id|index|latest> and list sessions ￼

In custom interface mode, the cleanest approach is:
• parse the init.session_id from stream-json output ￼
• store it in your session registry
• on next turn run: gemini -p "...followup..." --resume <session_id> --output-format stream-json

Approvals and safety
Gemini headless mode exposes flags like --approval-mode, --allowed-tools, and --yolo for auto-approving actions. ￼
For custom interface mode, prefer:
• strict allowed-tools / approval-mode driven by UI settings
• --yolo only as an explicit “danger mode” toggle.

⸻

Canonical event model (the secret sauce for UI)

You’ll get the best UI if you standardize everything into a small set of canonical events.

Minimal canonical event types

Run lifecycle
• run.started, run.completed, run.failed

Node lifecycle
• node.created (with type: orchestrator|agent)
• node.started
• node.blocked (waiting for approval / input / dependency)
• node.completed
• node.failed

Messages
• message.user (turn start)
• message.assistant.delta (streaming text chunks)
• message.assistant.final
• message.reasoning (provider-emitted reasoning/plan deltas)

Tools
• tool.proposed (command/tool args, risk level)
• tool.approval.requested
• tool.approval.resolved (allow/deny/modify)
• tool.started
• tool.completed (stdout/stderr/snippet, exit code, artifacts)

Artifacts
• artifact.diff (patch)
• artifact.file (path, content hash)
• artifact.test_result (suite, pass/fail)

Console (raw)
• console.chunk (stream=stdout|stderr, bytes, ts)

Provider mapping (practical)
• Codex JSONL → map item types (messages, reasoning, command executions, file changes) into canonical message/tool/artifact events. ￼
• Claude stream-json / json → map messages + structured_output + tool usage into same canonical types. ￼
• Gemini stream-json → map tool_use, tool_result, message, result events. ￼

⸻

UI/UX design: what I’d ship as “optimal”

Global layout: “Run Workspace”

Use a 3-pane layout that stays stable as complexity increases:

(1) Left: Runs + Orchestrators
• Run list (active + historical)
• Inside a run: Orchestrator instances (O1, O2, O3…) with status
• Quick filters: running / blocked / failed / completed

(2) Center: Graph Canvas
• Pan/zoom graph view (React Flow / Cytoscape-like)
• Auto-layout (DAG + swimlanes)
• Real-time edge animations for handoffs (more below)

(3) Right: Node Inspector
• A detail panel that updates when you click a node.

This is the right structure for “many orchestrators at once”.

⸻

Graph design: nodes, edges, and handoffs

Node types (visually distinct)
• Orchestrator node: “brain” icon, thicker border
• Agent node: provider logo + label (Codex/Claude/Gemini)
• Tool node (optional): smaller child nodes representing tool execution
• Artifact node (optional): diff/test output nodes

Edge semantics (what the graph actually means)
• Solid edge: dependency (“must finish before”)
• Dashed edge: handoff (“context+instructions sent to agent”)
• Dotted edge: feedback/report (“agent reports back to orchestrator”)

The “handoff visualization” you asked for

Do this as a first-class animation:

When orchestrator dispatches work:
• emit handoff.sent event
• animate a small “packet” traveling along the edge into the agent node

When agent reports back:
• emit handoff.reported event
• animate back toward orchestrator

This makes parallelism and delegation visceral, not just logs.

⸻

Node Inspector: the “custom interface mode” core experience

When a node is selected, show these tabs:

1. Overview
   • Objective, provider, model
   • Status + timing (queued/running/blocked)
   • Capabilities (read/write/execute/network)
   • Session ID (provider-native)
   • Cost/tokens (if available)

2. Conversation

A chat-like view (turn-based), but enhanced:
• “User turn” messages
• “Assistant streaming” messages (live deltas)
• Collapsible “Reasoning/Plan updates” section (only if emitted by harness; label it carefully)

Codex can emit reasoning items in JSON events; Gemini sessions store reasoning summaries; Claude can provide partial message events in stream-json. ￼

3. Tools

A structured list:
• tool name + args
• status (proposed / approved / running / done)
• output preview + “open full output”
• link to any generated artifact nodes

For Codex, this maps naturally from command execution / file change items. ￼

4. Files & Diffs
   • Monaco diff viewer
   • “Apply patch” (if your orchestrator supports it)
   • “Open file” deep links

5. Context

This is critical for debugging multi-agent orchestration:
• The exact instruction payload sent to this node
• Attached context sources (files, summaries)
• Any constraints (tools allowed, budget, max turns)

(Claude even supports a --max-turns flag for print mode; you can surface that as a slider per node.) ￼

6. Events

An event log (canonical + provider raw event)
• filter: messages/tools/artifacts/console/errors
• jump-to-time in Raw Console

7. Raw Console

Terminal-style viewer that shows:
• merged stdout/stderr with timestamps
• ANSI rendering toggle (on by default)
• “Copy selection”, “Download transcript”
• “Show only stderr”
• “Search in console”

Even in custom interface mode, this tab should make users think:
“Yeah, I basically have the CLI transcript here.”

⸻

Approvals UX (global, not per-node)

You’ll get much better UX if approvals are handled like an “inbox”:

Approval Queue panel
• a global queue of pending approvals across nodes
• each item shows:
• node name + provider
• proposed action (command/tool/file write)
• risk level (low/med/high)
• diff preview / command preview
• buttons: Approve once, Approve always in this node, Deny, Modify

How to implement approvals per provider
• Codex: in custom interface mode, the simplest reliable approach is to avoid interactive prompts and rely on sandbox + --ask-for-approval never, then implement your own gating by choosing sandbox levels and allowed actions. OpenAI documents that --ask-for-approval never disables approval prompts across sandbox modes. ￼
• Claude Code: best-in-class option is routing permission prompts to your orchestrator using --permission-prompt-tool (MCP) so approvals happen inside your UI. ￼
• Gemini: use --approval-mode / --allowed-tools (and reserve --yolo for explicit danger mode). ￼

⸻

“Turn-based but still full session”: how to guarantee it

The user fear is: “If we run a new process per turn, aren’t we losing continuity?”

You avoid that by making session continuity explicit.

Recommended session strategy
• Codex
• Parse thread_id from JSON events. ￼
• Continue with codex exec resume <id> (or --last). ￼
• Claude Code
• Use --session-id (UUID) per conversation/node, so it’s stable. ￼
• Or capture session_id from --output-format json and --resume it.
• Gemini
• Parse init.session_id from --output-format stream-json. ￼
• Resume with --resume <session_id>. ￼

So yes: you’re “turn-based” at the orchestration layer, but the underlying providers are still operating in a real session, and your UI can show the complete history.

⸻

Implementation details that matter a lot in practice

1. Always prefer streaming machine formats
   • Codex: --json ￼
   • Claude: --output-format stream-json (+ partial messages) ￼
   • Gemini: --output-format stream-json ￼

This gives you:
• live UI updates
• natural graph animations (“handoff packets”)
• robust intermediate state for debugging

2. Persist raw + structured

Even if structured parsing fails, you can:
• show raw console
• mark node as “parsed with errors”
• allow the user to download the transcript

3. Scale the UI with virtualization

Console output can be huge.
• chunk it (e.g., 4KB–32KB)
• store chunks
• render only visible region
• provide “jump to end” and “pause autoscroll”

4. Don’t promise hidden chain-of-thought

Show:
• provider-emitted reasoning summaries / plan updates
• tool decisions
• diffs and verification steps

Codex explicitly emits “reasoning” items in its event stream; Gemini stores reasoning summaries in sessions (when available). ￼

⸻

Optional but powerful: use an existing tracing model as your backbone

If you’re using OpenAI’s Agents SDK anywhere in the orchestrator:
• it has built-in tracing for LLM generations, tool calls, handoffs, guardrails, and custom events ￼
• sessions auto-maintain conversation history ￼

Even if you’re orchestrating external CLIs, you can model your event store similarly (span-like nodes, edges as handoffs). That makes your UI feel “native” to multi-agent tracing.

⸻

If you want, I can next give you… 1. A concrete canonical event JSON schema (Typescript types) + mapping rules for Codex/Claude/Gemini 2. A recommended graph layout spec (node types, edge types, grouping strategy for “multiple orchestrators”) 3. A UI spec for “handoff animations” and “approval queue” interactions (exact states + transitions) 4. The “minimal viable custom interface mode” plan that you can build in ~1–2 increments, without boiling the ocean

Just tell me whether your frontend is leaning React (web), Tauri, Electron, or SwiftUI (if you already know).
