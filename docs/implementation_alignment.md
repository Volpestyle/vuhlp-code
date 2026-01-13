vuhlp code — Implementation Alignment Doc (v0→v1)

0. Non‑negotiable principles

0.1 Docs-first autonomy baseline

When there is ambiguity, the system must prefer this order: 1. Consult existing docs (repo /docs, plus tool harness docs like AGENTS.md). 2. If docs are missing/insufficient, create or update docs first (Doc Iteration Phase). 3. Only then proceed to implement code.

This is how we “optimize for full autonomy” without silently guessing: document assumptions, then implement to the documented contract.

0.2 “Plan vs Implement” is a first-class mode
• Plan mode: produce/iterate docs until a coherent implementable contract exists.
• Implement mode: use docs as source-of-truth, execute tasks, and update docs at the end of each major loop checkpoint.

0.3 Observability is product-critical

Everything the orchestrator does must be representable as a graph:
• Nodes = orchestrators + agents + tools + verification steps
• Edges = handoffs, dependencies, result returns
• Every node must have:
• working context (inputs/context pack)
• transcript (user-visible messages)
• event stream (harness events)
• artifacts produced (diffs, files, JSON outputs, logs)

Note: You can’t reliably expose “raw chain-of-thought” for many models/tools. Instead, store and show:
• explicit tool events
• step plans and decisions
• “rationale summaries” (model-generated, short, non-sensitive)
• structured outputs and verification receipts
This matches what modern harnesses actually provide (e.g., Codex JSONL events, Claude stream-json, Agents SDK tracing). ￼

⸻

1. System architecture overview

1.1 Core components 1. Orchestrator Runtime (backend service)
• Owns loop execution, scheduling, mode switching, and state.
• Talks to agent harnesses (Codex CLI/SDK, Claude Code/SDK, Gemini CLI).
• Emits a unified event stream (WebSocket/SSE) for UI. 2. Harness Adapters
• CodexAdapter
• ClaudeCodeAdapter
• ClaudeAgentSDKAdapter (optional but recommended for deep control)
• GeminiCLIAdapter
• Each adapter normalizes: start/resume/send message/stream events/cancel 3. State Store (event-sourced)
• Append-only RunEvent log
• Materialized views: task graph, node status, transcripts, artifacts
• Session registry (provider session IDs / thread IDs) 4. Docs Engine
• Doc iteration pipeline (generate/update docs, review, publish)
• Doc index + retrieval (RAG-like, but docs are primary memory) 5. UI
• Custom interface mode: graph + inspector + chat + artifacts
• Raw console tab: embedded PTY sessions per agent
• Multi-orchestrator view: multiple graphs, shared project context

⸻

2. States, phases, and loop

2.1 Run state machine (top-level)

Use this deterministic state machine for every Run: 1. BOOT
• Load project, detect repo state, load docs index
• Detect harness availability and auth status 2. DOCS_ITERATION (conditional)
• Triggered if:
• repo is empty, OR
• repo has only /docs (or no code), OR
• docs missing critical sections required to implement safely
• Outcome: doc set that can support plan/implement 3. INVESTIGATE
• Repo scan, constraints, dependencies, existing tests, current architecture
• Produce “fact base” 4. PLAN
• Create task DAG + acceptance criteria
• Produce/refresh /docs/PLAN.md and /docs/ACCEPTANCE.md 5. EXECUTE
• Schedule ready tasks, run agents, merge results
• Update graph with streaming 6. VERIFY
• Run checks/tests/lints/build, plus doc completeness checks
• If failing: create new tasks → back to EXECUTE (or DOCS_ITERATION if ambiguity) 7. DOCS_SYNC (checkpoint)
• Update docs to match reality, record decisions, generate changelog
• GPT‑5.2 Pro “final doc review & synthesis” gate 8. DONE
• Export final report + updated docs + artifacts

2.2 “Self-looping” definition

A Run loops until:
• All plan tasks are Done,
• Acceptance checks pass,
• Docs are updated to reflect final system state,
• And “Completeness verifier” returns success.

If any of those fail: loop continues (EXECUTE ↔ VERIFY ↔ DOCS_SYNC). This is the “keep iterating until you can verify completeness” requirement.

⸻

3. Auto vs Interactive mode (the toggle you described)

3.1 Modes

AUTO mode
• Orchestrator may dispatch prompts to agents without user intervention.
• Orchestrator may re-prompt an agent multiple times until completion (within budgets).
• Approvals/tool permissions should be configured to minimize friction but remain safe.

INTERACTIVE mode
• Automation pauses.
• No new orchestrator-dispatched agent prompts.
• Users can:
• chat with any agent node (Codex/Claude/Gemini) directly
• inspect context packs
• approve/deny pending actions
• modify docs manually
• When toggled back to AUTO: orchestrator ingests new events and continues.

3.2 Pause semantics (important)

“Everything pauses” must be cooperative:
• If an agent is mid-turn streaming output, let it finish that turn.
• Orchestrator sets pause_requested=true.
• At the next safe boundary (turn completed), node state becomes PAUSED.
• Orchestrator enters INTERACTIVE and stops scheduling.

3.3 Resume semantics

When switching back to AUTO: 1. Orchestrator ingests any interactive-mode transcripts/artifacts 2. Recomputes:
• plan progress
• unmet acceptance criteria
• missing docs updates 3. Schedules next ready tasks

3.4 UI controls required
• Global toggle: AUTO ⇄ INTERACTIVE
• “Pause after this turn” (default behavior when switching)
• Per-node:
• “Take control” (focus chat input on that node)
• “Release control” (node returns to orchestrator control)
• A “Prompt Queue” panel showing:
• orchestrator-intended prompts waiting due to interactive mode
• user-written prompts waiting to be sent

⸻

4. Harness integration (use defaults as much as possible)

4.1 Codex (CLI and/or SDK)

4.1.1 Authentication

Codex supports:
• Sign in with ChatGPT (subscription access)
• API key (usage-based)

CLI authentication command:
• codex login (browser OAuth by default)
• codex login --with-api-key (read key from stdin)
• codex login status (check logged-in)

Implementation guidance:
Your tool should not re-implement OAuth for Codex. Instead:
• detect status via codex login status
• if not authed, launch codex login inside the raw console tab or a guided UI flow

4.1.2 Non-interactive / orchestration mode

Use codex exec for node runs; use --json to stream machine-readable JSONL events. ￼

Key flags:
• --json prints newline-delimited JSON events
• --output-schema path enforces final output schema
• resume: codex exec resume [SESSION_ID] or --last ￼

Safety/approval control:
• --ask-for-approval with values untrusted | on-failure | on-request | never
• --sandbox with values read-only | workspace-write | danger-full-access
• --full-auto preset (low-friction local automation)

4.1.3 Streaming + UI mapping

Codex --json emits event types like thread/turn/item lifecycle events. ￼
Your adapter must map those into:
• NodeEvent.StreamChunk (partial assistant output)
• NodeEvent.ToolCall (command/file operation)
• NodeEvent.Status (turn started/completed)
• NodeEvent.FinalResult

4.1.4 Project instructions injection via AGENTS.md (critical)

Codex reads AGENTS.md before doing work and supports layering global + project guidance.

Why this matters for vuhlp code:
You can implement “system prompt” control for Codex without hacking prompts per turn by writing:
• a run-scoped CODEX_HOME directory containing a global AGENTS.md
• plus repo-level AGENTS.md for project norms

Codex discovery rules and override behavior are documented (global + project precedence, override filenames, max bytes, fallback filenames).

Implementation recommendation:
• For each Run, create: /.vuhlp/codex_home/AGENTS.md and run Codex with CODEX_HOME=...
• Keep repo-level AGENTS.md owned by the user; only write it if user explicitly approves (or if you’re in a “bootstrap” wizard)

⸻

4.2 Claude Code (CLI)

4.2.1 Headless mode for orchestration

Claude Code supports:
• --output-format text|json|stream-json
• stream-json = newline-delimited JSON for real-time streaming
• --json-schema for schema-validated structured output in JSON mode
• --continue (resume most recent conversation) and --resume <session_id>
• --allowedTools to allow specific tools without prompting
• --append-system-prompt to add instructions while keeping defaults
• --max-turns to cap agent turn count in print mode

4.2.2 Session continuity requirement

To maintain end-to-end session (your question from earlier):
• Capture session_id from --output-format json
• Store in AgentSession
• Continue with --resume <session_id> in subsequent turns

4.2.3 Tool approvals policy

In AUTO:
• Prefer --allowedTools allow-list per task step (principle of least privilege).
In INTERACTIVE:
• Don’t pass broad allow-lists; let the user approve prompts in the UI.

⸻

4.3 Claude Agent SDK (recommended for “custom interface mode”)

Claude’s Agent SDK:
• exposes the same tools/loop/context management as Claude Code
• supports subagents, hooks, permission controls, and streaming ￼

Why it’s optimal in your design:
• You can implement your own UI approvals cleanly (permissions + hooks).
• You get structured streaming events (good for graph visualization).
• You can spawn subagents for parallel tasks while keeping orchestrator context clean. ￼

Recommendation:
• Support Claude Code CLI as “default harness” (subscription users, minimal work).
• Add Claude Agent SDK as “advanced harness” (better integration, enterprise/API use).

⸻

4.4 Gemini CLI

Gemini CLI supports:
• Google account OAuth login, API key, or Vertex AI ￼
• Headless prompt mode (-p) and output formats including JSON and streamable JSON (per CLI docs/readme) ￼
• Session management / resume workflows are documented publicly ￼

Implementation guidance:
• Treat Gemini CLI exactly like Codex/Claude CLI: spawn process, parse NDJSON if chosen, store session identifiers, resume on follow-up.

⸻

4.5 OpenAI Agents SDK (for orchestrator + doc reviewer)

Use OpenAI Agents SDK for:
• Orchestrator agent(s)
• Document reviewer/synthesizer agent (GPT‑5.2 Pro if available)
• Tracing + event timeline

Core features:
• Session memory to maintain conversation across runs
• Tracing spans for visualizing handoffs/tools/steps
• Structured outputs to enforce JSON schemas
• Patterns for structured state via RunContextWrapper
• Context management via trimming/compression patterns

⸻

5. Prompting design (exactly how to prompt orchestrator and nodes)

5.1 “SOTA” approach: Stable system prompt + structured state injection

Do not rewrite the full system prompt every turn.

Instead:
• System prompt stays constant
• You inject changing run state via:
• a structured “run context” object (Agents SDK RunContextWrapper)
• retrieval-selected doc excerpts (“context pack”)
• concise event deltas (“what changed since last tick”)

This keeps runs coherent, cheaper, and less drift-prone.

⸻

5.2 Orchestrator prompting (AUTO vs INTERACTIVE)

5.2.1 Orchestrator system prompt (constant)

Use something like:

You are the vuhlp Orchestrator.
Your job: deliver complete, verified outcomes by orchestrating multiple coding agents (Codex, Claude Code, Gemini) and verification tools.

Non-negotiables:

- Docs-first: if requirements are ambiguous or missing, update /docs before implementing.
- Plan vs Implement: Always maintain /docs/PLAN.md and /docs/ACCEPTANCE.md. Treat docs as contract.
- Verification: never declare done without objective checks (tests, build, lint, acceptance criteria).
- Observability: every action must be representable as graph events (spawn node, send prompt, receive result, verify, doc update).
- Safety: obey tool permission policies; never use dangerous modes unless explicitly enabled.
- Privacy: do not reveal hidden chain-of-thought; provide short rationale summaries instead.

Mode rules:

- AUTO: you may dispatch prompts to nodes and re-prompt nodes until completion within budgets.
- INTERACTIVE: do NOT dispatch new prompts; wait for the user to drive. You may analyze and update plan/docs, and respond to user questions.

Output contract:

- When deciding actions, emit a JSON object describing next scheduling actions (spawn/continue/pause/verify/doc_update).

Why JSON action output:
Because your runtime should treat the orchestrator as a planner/scheduler producing machine-readable decisions, not a chatty narrator. Use OpenAI Structured Outputs for strict schema compliance.

5.2.2 Orchestrator initial user prompt (AUTO)

This is the one time “start run” prompt (your question: “on auto it’d be only first time”):

Include:
• user goal/spec
• repo scan summary
• docs inventory summary
• harness availability + auth status
• execution budgets (max nodes, max turns, timeouts)
• policies (docs-first, plan/implement)
• output schema for OrchestratorAction

Example skeleton:

Goal:
<user prompt/spec>

Repository state:

- git root: ...
- languages: ...
- tests: ...
- docs present: ...
- empty repo? yes/no

Docs-first policy:

- If missing required docs, enter DOCS_ITERATION.

Available harnesses:

- Codex CLI: available=true, auth=status=...
- Claude Code: available=true, auth=status=...
- Gemini CLI: available=true, auth=status=...

Budgets:

- max_parallel_nodes=6
- max_orchestrator_turns_before_yield=20
- max_total_iterations=30
- require_verification=true

Return only JSON actions matching schema.

5.2.3 Orchestrator subsequent “ticks” (AUTO)

AUTO runs should proceed without user messages, but your runtime will still need to “wake” the orchestrator when:
• nodes complete
• verification finishes
• docs updated
• budgets exceeded

Do it via synthetic tick input (not a new system prompt), e.g.:

[TICK]
Mode=AUTO
Delta since last tick:

- Node N123 completed with result artifact A9
- Tests failed: 2 failing
- Docs pending update: /docs/ARCHITECTURE.md

Current plan status:

- 8/14 tasks done; 2 blocked; 4 ready

What next actions should be scheduled?
Return JSON actions only.

5.2.4 Interactive prompting (INTERACTIVE)

In INTERACTIVE:
• User messages go to orchestrator as normal chat input.
• Orchestrator may respond, update plan, request specific user actions.
• Orchestrator must not dispatch node prompts unless:
• user explicitly clicks “Send” on a prepared prompt, OR
• user toggles back to AUTO

⸻

5.3 Prompting agent nodes (Codex/Claude/Gemini)

5.3.1 Node “system prompt” vs “user prompt”

Because you’re using default harnesses:
• Codex: use AGENTS.md layering as your persistent “system prompt”.
• Claude Code: use --append-system-prompt minimally when needed; otherwise keep defaults.
• Gemini CLI: prefer its native project context mechanisms (and your own context pack injection).

5.3.2 Node prompt structure (always)

Every node prompt must include: 1. Task objective 2. Definition of done (DoD) 3. Constraints (files, style, tool permissions) 4. Inputs (context pack + doc excerpts) 5. Output contract (JSON schema or structured format) 6. Reporting protocol (“report back to orchestrator” fields)

5.3.3 Context pack (critical)

Never dump the whole repo transcript into each node. Instead generate a compact pack:

{
"task_id": "T-014",
"goal": "Implement websocket reconnect backoff",
"docs_source_of_truth": [
{"path": "/docs/ARCHITECTURE.md", "anchors": ["realtime", "reconnect-policy"]},
{"path": "/docs/ACCEPTANCE.md", "anchors": ["websocket-backoff"]}
],
"repo_facts": {
"language": "ts",
"entrypoints": ["src/app.ts"],
"tests": ["pnpm test"]
},
"relevant_files": [
{"path":"src/ws/client.ts","summary":"..."},
{"path":"src/ws/retry.ts","summary":"..."}
],
"prior_results": [
{"from":"Agent:Claude#A3","artifact":"A12","summary":"..."}
],
"constraints": {
"no_new_dependencies": true,
"must_update_docs_on_behavior_change": true
},
"output_schema": "Patch+Report schema v1"
}

5.3.4 Output schema patterns (recommended)

Use schemas everywhere possible:
• Codex: --output-schema path
• Claude Code: --output-format json --json-schema '{...}'
• OpenAI orchestrator: Structured Outputs

This is how you keep autonomy reliable and machine-integrable.

⸻

6. Concurrency: what can run in parallel vs what blocks

6.1 Safe parallel categories

These can run concurrently with minimal coordination:
• Investigation / repo reading
• Doc drafting (different files)
• Research tasks
• Independent feature tasks (if isolated workspaces are used)

6.2 Blocking categories

These should be treated as blocking steps (graph “gates”): 1. Merge/integration of multiple code edits 2. Running tests/build (especially if they mutate shared state) 3. Acceptance verification 4. Doc sync + final review 5. Interactive mode (global pause gate)

6.3 Write-concurrency policy (recommended)

To avoid agents stepping on each other:
• Read-only tasks: may share working directory.
• Write tasks: should use isolated workspaces:
• git worktrees per node, or
• separate clones, or
• a patch-only workflow (agent returns diffs; orchestrator applies)

Pragmatic v0/v1 choice:
• Allow parallel read-only nodes
• Serialize write nodes unless using worktrees

⸻

7. Documentation Iteration Phase (empty repo / docs-only repo)

7.1 Triggers

Enter DOCS_ITERATION if:
• repo has no code, OR
• repo has only /docs, OR
• “Plan mode required docs” missing:
• /docs/OVERVIEW.md
• /docs/ARCHITECTURE.md
• /docs/PLAN.md
• /docs/ACCEPTANCE.md
• /docs/DECISIONS.md

7.2 Pipeline (docs iteration loop) 1. Docs gap analysis (orchestrator) 2. Spawn doc agents in parallel:
• “Architecture drafter”
• “UX spec drafter”
• “Harness integration drafter”
• “Security/permissions drafter” 3. Merge drafts → single coherent doc set 4. GPT‑5.2 Pro final review + synthesis
• enforce consistency
• eliminate contradictions
• produce acceptance criteria 5. Publish docs to /docs 6. Exit to PLAN

7.3 “Docs are source of truth” enforcement

In implement mode:
• If an agent proposes behavior that contradicts docs:
• orchestrator must route to DOCS_SYNC (or require doc update first)

⸻

8. Does orchestrator keep prompting agents until completion?

Yes in AUTO, with guardrails:
• Each node has a max_turns budget (per harness).
• Orchestrator may send follow-up prompts to the same session:
• Codex: codex exec resume --last or explicit session ID ￼
• Claude Code: --continue / --resume <session_id>
• Gemini CLI: resume/session mechanisms ￼
• If repeated follow-ups fail:
• spawn a new “reviewer” node
• or escalate to interactive mode / ask user

In INTERACTIVE, orchestrator does not keep prompting—user drives.

⸻

9. Context maintenance (end-to-end sessions + “SOTA” memory)

9.1 What “SOTA” looks like in 2025–2026

A robust orchestration stack uses three layers: 1. Provider-native sessions (threads/session IDs)
• Preserves authentic CLI context end-to-end
• Enables “continue” behavior in your UI 2. Event-sourced run log
• Every token chunk/tool action/result becomes a replayable event
• Powers the graph UI 3. Curated working set (“context packs”)
• Minimal, relevant context per node
• Generated by retrieval + summarization + constraints

This is strictly better than dumping giant transcripts into every prompt.

9.2 OpenAI Agents SDK patterns for orchestrator memory

Use:
• Session for built-in multi-turn context
• structured run state via RunContextWrapper
• trimming/compression patterns for long runs
• tracing spans to feed the UI timeline

9.3 Passing “reasoning items”

Some reasoning-capable APIs emit internal “reasoning items” that should be passed back for tool continuity (where applicable). You can store them in internal state but avoid presenting them as “thoughts.”

⸻

10. Suggested optimal UI/UX for custom interface mode (+ raw console tab)

10.1 Top-level layout
• Left sidebar:
• Projects
• Runs
• Orchestrators (multi-orchestrator list)
• Agent sessions
• Docs tree
• Main canvas:
• Graph view (default)
• Right inspector:
• Node details
• Bottom panel (tabbed):
• Raw Console
• Artifacts
• Logs/Events
• Verification

10.2 Graph view requirements

Node types (icons/shape differences):
• Orchestrator node
• Agent node (Codex / Claude / Gemini)
• Verification node (tests/lint/build)
• Docs node (doc update / doc review)
• Tool node (git operations, file ops)

Edges:
• handoff (orchestrator → agent)
• dependency (task DAG)
• result (agent → orchestrator)
• verification (execute → verify)
• doc_sync (any → docs)

Interaction:
• click node → inspector shows:
• context pack
• transcript
• structured outputs
• artifacts (diff, files)
• harness event stream
• hover edge → show reason (“blocked by tests”, “waiting on T‑014”, etc.)

10.3 Raw console tab

For each agent session:
• Embedded PTY output (exact CLI interaction)
• Show session identity:
• Codex session/thread ID
• Claude session_id
• Gemini session id / checkpoint id
• Allow user to:
• type directly (interactive mode)
• copy/paste outputs to a node result

10.4 Custom interface mode (non-PTY)

Instead of raw terminal, you show:
• Chat bubbles (assistant/user/tool)
• Streaming chunks
• Tool calls as structured cards
• Approvals as explicit UI prompts
• “Rationale summaries” as a small collapsible block

This is where you get full visibility + custom UI.

10.5 AUTO/INTERACTIVE UX

Global toggle with states:
• AUTO (green)
• INTERACTIVE (yellow, “automation paused” banner)

When entering INTERACTIVE:
• show modal:
• “Pause after current turns finish”
• “Stop scheduling new prompts immediately”
• show which nodes are still “RUNNING” vs “PAUSED”

When returning to AUTO:
• show “resume summary” diff:
• what changed during interactive
• what tasks are now ready
• what docs must be updated

⸻

11. Roadmap notes (future improvements)

v1
• git worktree isolation for parallel write tasks
• unified “Context Pack Builder” agent
• first-class “Acceptance Checklist” UI with auto-checks

v2
• dynamic multi-orchestrator decomposition (meta-orchestrator spawns orchestrators per subsystem)
• conflict-aware merge assistant
• provider-agnostic tool-call normalization (closer to a common MCP-like tool layer)

v3
• distributed runners (remote agent sessions)
• richer verification: fuzzing, property tests, security scans
• policy packs (teams can encode rules/permissions centrally)

⸻

12. Implementation checklist (what you build next)

If you want to align the current repo to this doc “exactly”, implement in this order: 1. RunEvent schema + event-sourced store 2. Graph materializer (events → graph state) 3. Mode switch system (AUTO/INTERACTIVE gates) 4. Harness adapters for:
• Codex exec + --json + resume
• Claude headless + stream-json + resume
• Gemini headless + stream-json + resume 5. Orchestrator agent (Agents SDK) emitting JSON actions 6. Docs iteration pipeline + doc sync gate (GPT‑5.2 Pro reviewer) 7. UI: graph view + node inspector + raw console tab

⸻
