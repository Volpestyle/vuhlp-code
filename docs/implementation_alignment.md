# vuhlp code — Implementation Alignment Doc (v0→v1)

> **Legend:**
> - **[v0 IMPLEMENTED]** — Feature is fully implemented in v0
> - **[v0 PARTIAL]** — Types/structure defined, basic implementation exists
> - **[v1 PLANNED]** — Feature is planned for v1, not yet implemented

---

## 0. Non-negotiable Principles

### 0.1 Docs-first Autonomy Baseline

When there is ambiguity, the system must prefer this order:
1. Consult existing docs (repo /docs, plus tool harness docs like AGENTS.md)
2. If docs are missing/insufficient, create or update docs first (Doc Iteration Phase)
3. Only then proceed to implement code

This is how we "optimize for full autonomy" without silently guessing: document assumptions, then implement to the documented contract.

### 0.2 "Plan vs Implement" is a First-class Mode

- **Plan mode:** produce/iterate docs until a coherent implementable contract exists
- **Implement mode:** use docs as source-of-truth, execute tasks, and update docs at the end of each major loop checkpoint

### 0.3 Observability is Product-critical

Everything the orchestrator does must be representable as a graph:
- Nodes = orchestrators + agents + tools + verification steps
- Edges = handoffs, dependencies, result returns
- Every node must have:
  - working context (inputs/context pack)
  - transcript (user-visible messages)
  - event stream (harness events)
  - artifacts produced (diffs, files, JSON outputs, logs)

Note: You can't reliably expose "raw chain-of-thought" for many models/tools. Instead, store and show:
- explicit tool events
- step plans and decisions
- "rationale summaries" (model-generated, short, non-sensitive)
- structured outputs and verification receipts

This matches what modern harnesses actually provide (e.g., Codex JSONL events, Claude stream-json, Agents SDK tracing).

---

## 1. System Architecture Overview

### 1.1 Core Components

| Component | Status |
|-----------|--------|
| Orchestrator Runtime | **[v0 IMPLEMENTED]** |
| Harness Adapters (Codex, Claude, Gemini) | **[v0 IMPLEMENTED]** |
| ClaudeAgentSDKAdapter | **[v1 PLANNED]** |
| State Store (event-sourced) | **[v0 IMPLEMENTED]** |
| Session Registry | **[v0 IMPLEMENTED]** |
| Docs Engine (full pipeline) | **[v1 PLANNED]** |
| UI (graph + inspector + chat) | **[v0 IMPLEMENTED]** |
| Raw Console Tab | **[v0 IMPLEMENTED]** |
| Multi-orchestrator View | **[v1 PLANNED]** |

**1. Orchestrator Runtime (backend service)**
- Owns loop execution, scheduling, mode switching, and state
- Talks to agent harnesses (Codex CLI, Claude Code CLI, Gemini CLI)
- Emits a unified event stream (WebSocket) for UI

**2. Harness Adapters**
- CodexAdapter **[v0 IMPLEMENTED]**
- ClaudeCodeAdapter **[v0 IMPLEMENTED]**
- ClaudeAgentSDKAdapter **[v1 PLANNED]** — optional but recommended for deep control
- GeminiCLIAdapter **[v0 IMPLEMENTED]**
- Each adapter normalizes: start/resume/send message/stream events/cancel

**3. State Store (event-sourced)**
- Append-only RunEvent log **[v0 IMPLEMENTED]**
- Materialized views: task graph, node status, transcripts, artifacts **[v0 IMPLEMENTED]**
- Session registry (provider session IDs / thread IDs) **[v0 IMPLEMENTED]**

**4. Docs Engine**
- Doc iteration pipeline (generate/update docs, review, publish) **[v1 PLANNED]**
- Doc index + retrieval (RAG-like, but docs are primary memory) **[v1 PLANNED]**

**5. UI**
- Custom interface mode: graph + inspector + chat + artifacts **[v0 IMPLEMENTED]**
- Raw console tab: embedded PTY sessions per agent **[v0 IMPLEMENTED]**
- Multi-orchestrator view: multiple graphs, shared project context **[v1 PLANNED]**

---

## 2. States, Phases, and Loop

### 2.1 Run State Machine (top-level)

Use this deterministic state machine for every Run:

| Phase | Status |
|-------|--------|
| 1. BOOT | **[v0 IMPLEMENTED]** |
| 2. DOCS_ITERATION | **[v0 PARTIAL]** — Types defined, triggers work, full workflow is v1 |
| 3. INVESTIGATE | **[v0 IMPLEMENTED]** |
| 4. PLAN | **[v0 IMPLEMENTED]** |
| 5. EXECUTE | **[v0 IMPLEMENTED]** |
| 6. VERIFY | **[v0 IMPLEMENTED]** |
| 7. DOCS_SYNC | **[v0 PARTIAL]** — Types defined, minimal implementation |
| 8. DONE | **[v0 IMPLEMENTED]** |

**1. BOOT**
- Load project, detect repo state, load docs index
- Detect harness availability and auth status

**2. DOCS_ITERATION (conditional)** — **[v1 PLANNED for full workflow]**
- Triggered if:
  - repo is empty, OR
  - repo has only /docs (or no code), OR
  - docs missing critical sections required to implement safely
- Outcome: doc set that can support plan/implement

**3. INVESTIGATE**
- Repo scan, constraints, dependencies, existing tests, current architecture
- Produce "fact base"

**4. PLAN**
- Create task DAG + acceptance criteria
- Produce/refresh /docs/PLAN.md and /docs/ACCEPTANCE.md

**5. EXECUTE**
- Schedule ready tasks, run agents, merge results
- Update graph with streaming

**6. VERIFY**
- Run checks/tests/lints/build, plus doc completeness checks
- If failing: create new tasks → back to EXECUTE (or DOCS_ITERATION if ambiguity)

**7. DOCS_SYNC (checkpoint)** — **[v1 PLANNED for full workflow]**
- Update docs to match reality, record decisions, generate changelog
- GPT-5.2 Pro "final doc review & synthesis" gate

**8. DONE**
- Export final report + updated docs + artifacts

### 2.2 "Self-looping" Definition

A Run loops until:
- All plan tasks are Done
- Acceptance checks pass
- Docs are updated to reflect final system state
- And "Completeness verifier" returns success

If any of those fail: loop continues (EXECUTE ↔ VERIFY ↔ DOCS_SYNC). This is the "keep iterating until you can verify completeness" requirement.

---

## 3. Auto vs Interactive Mode

**[v0 IMPLEMENTED]**

### 3.1 Modes

**AUTO mode**
- Orchestrator may dispatch prompts to agents without user intervention
- Orchestrator may re-prompt an agent multiple times until completion (within budgets)
- Approvals/tool permissions should be configured to minimize friction but remain safe

**INTERACTIVE mode**
- Automation pauses
- No new orchestrator-dispatched agent prompts
- Users can:
  - chat with any agent node (Codex/Claude/Gemini) directly
  - inspect context packs
  - approve/deny pending actions
  - modify docs manually
- When toggled back to AUTO: orchestrator ingests new events and continues

### 3.2 Pause Semantics

**[v0 IMPLEMENTED]**

"Everything pauses" must be cooperative:
- If an agent is mid-turn streaming output, let it finish that turn
- Orchestrator sets pause_requested=true
- At the next safe boundary (turn completed), node state becomes PAUSED
- Orchestrator enters INTERACTIVE and stops scheduling

### 3.3 Resume Semantics

**[v0 IMPLEMENTED]**

When switching back to AUTO:
1. Orchestrator ingests any interactive-mode transcripts/artifacts
2. Recomputes:
   - plan progress
   - unmet acceptance criteria
   - missing docs updates
3. Schedules next ready tasks

### 3.4 UI Controls Required

| Control | Status |
|---------|--------|
| Global toggle: AUTO ⇄ INTERACTIVE | **[v0 IMPLEMENTED]** |
| "Pause after this turn" | **[v0 IMPLEMENTED]** |
| Per-node "Take control" | **[v0 IMPLEMENTED]** |
| Per-node "Release control" | **[v0 IMPLEMENTED]** |
| Prompt Queue panel | **[v0 IMPLEMENTED]** |

---

## 4. Harness Integration

### 4.1 Codex (CLI)

**[v0 IMPLEMENTED]**

#### 4.1.1 Authentication

Codex supports:
- Sign in with ChatGPT (subscription access)
- API key (usage-based)

CLI authentication command:
- `codex login` (browser OAuth by default)
- `codex login --with-api-key` (read key from stdin)
- `codex login status` (check logged-in)

Implementation guidance:
Your tool should not re-implement OAuth for Codex. Instead:
- detect status via `codex login status`
- if not authed, launch `codex login` inside the raw console tab or a guided UI flow

#### 4.1.2 Non-interactive / Orchestration Mode

**[v0 IMPLEMENTED]**

Use `codex exec` for node runs; use `--json` to stream machine-readable JSONL events.

Key flags:
- `--json` prints newline-delimited JSON events
- `--output-schema path` enforces final output schema
- resume: `codex exec resume [SESSION_ID]` or `--last`

Safety/approval control:
- `--ask-for-approval` with values: `untrusted | on-failure | on-request | never`
- `--sandbox` with values: `read-only | workspace-write | danger-full-access`
- `--full-auto` preset (low-friction local automation)

#### 4.1.3 Streaming + UI Mapping

**[v0 IMPLEMENTED]**

Codex `--json` emits event types like thread/turn/item lifecycle events.
Adapter maps those into canonical ProviderOutputEvents.

#### 4.1.4 Project Instructions Injection via AGENTS.md

**[v0 IMPLEMENTED]**

Codex reads AGENTS.md before doing work and supports layering global + project guidance.

Implementation:
- Adapter auto-injects AGENTS.md content into prompts
- Searches workspace paths for AGENTS.md file
- Configurable via `agentsMdPath` and `injectAgentsMd` options

---

### 4.2 Claude Code (CLI)

**[v0 IMPLEMENTED]**

#### 4.2.1 Headless Mode for Orchestration

Claude Code supports:
- `--output-format text|json|stream-json`
- `stream-json` = newline-delimited JSON for real-time streaming
- `--json-schema` for schema-validated structured output in JSON mode
- `--continue` (resume most recent conversation) and `--resume <session_id>`
- `--allowedTools` to allow specific tools without prompting
- `--append-system-prompt` to add instructions while keeping defaults
- `--max-turns` to cap agent turn count in print mode

#### 4.2.2 Session Continuity

**[v0 IMPLEMENTED]**

To maintain end-to-end session:
- Capture `session_id` from `--output-format json`
- Store in SessionRegistry
- Continue with `--resume <session_id>` in subsequent turns

#### 4.2.3 CLAUDE.md Injection

**[v0 IMPLEMENTED]**

Adapter auto-injects CLAUDE.md content into prompts. Searches for:
1. Configured `claudeMdPath`
2. `{workspace}/CLAUDE.md`
3. `{workspace}/.claude/CLAUDE.md`

#### 4.2.4 Tool Approvals Policy

In AUTO:
- Prefer `--allowedTools` allow-list per task step (principle of least privilege)

In INTERACTIVE:
- Don't pass broad allow-lists; let the user approve prompts in the UI

---

### 4.3 Claude Agent SDK

**[v1 PLANNED]**

Claude's Agent SDK:
- exposes the same tools/loop/context management as Claude Code
- supports subagents, hooks, permission controls, and streaming

Why it's optimal:
- You can implement your own UI approvals cleanly (permissions + hooks)
- You get structured streaming events (good for graph visualization)
- You can spawn subagents for parallel tasks while keeping orchestrator context clean

Recommendation:
- Support Claude Code CLI as "default harness" (subscription users, minimal work) **[v0 IMPLEMENTED]**
- Add Claude Agent SDK as "advanced harness" (better integration, enterprise/API use) **[v1 PLANNED]**

---

### 4.4 Gemini CLI

**[v0 IMPLEMENTED]**

Gemini CLI supports:
- Google account OAuth login, API key, or Vertex AI
- Headless prompt mode (`-p`) and output formats including JSON and streamable JSON
- Session management / resume workflows

Implementation:
- Treat Gemini CLI exactly like Codex/Claude CLI
- Spawn process, parse NDJSON, store session identifiers, resume on follow-up

---

### 4.5 OpenAI Agents SDK (for orchestrator + doc reviewer)

**[v1 PLANNED]**

Use OpenAI Agents SDK for:
- Orchestrator agent(s)
- Document reviewer/synthesizer agent (GPT-5.2 Pro if available)
- Tracing + event timeline

Core features:
- Session memory to maintain conversation across runs
- Tracing spans for visualizing handoffs/tools/steps
- Structured outputs to enforce JSON schemas
- Patterns for structured state via RunContextWrapper
- Context management via trimming/compression patterns

---

## 5. Prompting Design

### 5.1 "SOTA" Approach: Stable System Prompt + Structured State Injection

**[v0 PARTIAL]** — Basic prompting implemented, full context pack system is v1

Do not rewrite the full system prompt every turn.

Instead:
- System prompt stays constant
- You inject changing run state via:
  - a structured "run context" object
  - retrieval-selected doc excerpts ("context pack")
  - concise event deltas ("what changed since last tick")

This keeps runs coherent, cheaper, and less drift-prone.

### 5.2 Orchestrator Prompting

**[v0 IMPLEMENTED]** — Basic orchestrator prompting
**[v1 PLANNED]** — Full JSON action output schema + Agents SDK integration

#### 5.2.1 Orchestrator System Prompt (constant)

The orchestrator uses a stable system prompt defining:
- Docs-first policy
- Plan vs Implement modes
- Verification requirements
- Observability expectations
- Safety/privacy rules
- Mode rules (AUTO vs INTERACTIVE)
- Output contract

#### 5.2.2 Orchestrator Ticks (AUTO)

AUTO runs proceed without user messages, but the runtime "wakes" the orchestrator when:
- nodes complete
- verification finishes
- docs updated
- budgets exceeded

### 5.3 Prompting Agent Nodes

**[v0 IMPLEMENTED]**

#### 5.3.1 Context Pack

**[v0 PARTIAL]** — ContextPackBuilder exists, full retrieval is v1

Every node prompt includes:
1. Task objective
2. Definition of done (DoD)
3. Constraints (files, style, tool permissions)
4. Inputs (context pack + doc excerpts)
5. Output contract (JSON schema or structured format)
6. Reporting protocol

#### 5.3.2 Output Schema Patterns

**[v0 IMPLEMENTED]**

Use schemas everywhere possible:
- Codex: `--output-schema path`
- Claude Code: `--output-format json --json-schema '{...}'`

---

## 6. Concurrency

### 6.1 Safe Parallel Categories

**[v0 IMPLEMENTED]**

These can run concurrently with minimal coordination:
- Investigation / repo reading
- Doc drafting (different files)
- Research tasks
- Independent feature tasks (if isolated workspaces are used)

### 6.2 Blocking Categories

These should be treated as blocking steps (graph "gates"):
1. Merge/integration of multiple code edits
2. Running tests/build (especially if they mutate shared state)
3. Acceptance verification
4. Doc sync + final review
5. Interactive mode (global pause gate)

### 6.3 Write-concurrency Policy

| Strategy | Status |
|----------|--------|
| Read-only tasks share working directory | **[v0 IMPLEMENTED]** |
| Write tasks use isolated workspaces | **[v0 PARTIAL]** — workspace modes defined |
| Git worktrees per node | **[v1 PLANNED]** |
| Patch-only workflow | **[v1 PLANNED]** |

Pragmatic v0/v1 choice:
- Allow parallel read-only nodes **[v0 IMPLEMENTED]**
- Serialize write nodes unless using worktrees **[v0 IMPLEMENTED]**

---

## 7. Documentation Iteration Phase

**[v1 PLANNED]** — Full pipeline not yet implemented

### 7.1 Triggers

Enter DOCS_ITERATION if:
- repo has no code, OR
- repo has only /docs, OR
- "Plan mode required docs" missing:
  - /docs/OVERVIEW.md
  - /docs/ARCHITECTURE.md
  - /docs/PLAN.md
  - /docs/ACCEPTANCE.md
  - /docs/DECISIONS.md

### 7.2 Pipeline (docs iteration loop)

**[v1 PLANNED]**

1. Docs gap analysis (orchestrator)
2. Spawn doc agents in parallel:
   - "Architecture drafter"
   - "UX spec drafter"
   - "Harness integration drafter"
   - "Security/permissions drafter"
3. Merge drafts → single coherent doc set
4. GPT-5.2 Pro final review + synthesis
   - enforce consistency
   - eliminate contradictions
   - produce acceptance criteria
5. Publish docs to /docs
6. Exit to PLAN

### 7.3 "Docs are Source of Truth" Enforcement

**[v1 PLANNED]**

In implement mode:
- If an agent proposes behavior that contradicts docs:
  - orchestrator must route to DOCS_SYNC (or require doc update first)

---

## 8. Does Orchestrator Keep Prompting Agents Until Completion?

**[v0 IMPLEMENTED]**

Yes in AUTO, with guardrails:
- Each node has a max_turns budget (per harness)
- Orchestrator may send follow-up prompts to the same session:
  - Codex: `codex exec resume --last` or explicit session ID
  - Claude Code: `--continue` / `--resume <session_id>`
  - Gemini CLI: resume/session mechanisms
- If repeated follow-ups fail:
  - spawn a new "reviewer" node
  - or escalate to interactive mode / ask user

In INTERACTIVE, orchestrator does not keep prompting—user drives.

---

## 9. Context Maintenance

### 9.1 Three-layer Stack

**[v0 IMPLEMENTED]**

A robust orchestration stack uses three layers:

1. **Provider-native sessions (threads/session IDs)** — **[v0 IMPLEMENTED]**
   - Preserves authentic CLI context end-to-end
   - Enables "continue" behavior in your UI

2. **Event-sourced run log** — **[v0 IMPLEMENTED]**
   - Every token chunk/tool action/result becomes a replayable event
   - Powers the graph UI

3. **Curated working set ("context packs")** — **[v0 PARTIAL]**
   - Minimal, relevant context per node
   - Generated by retrieval + summarization + constraints
   - Full RAG retrieval is **[v1 PLANNED]**

### 9.2 OpenAI Agents SDK Patterns

**[v1 PLANNED]**

Use:
- Session for built-in multi-turn context
- structured run state via RunContextWrapper
- trimming/compression patterns for long runs
- tracing spans to feed the UI timeline

---

## 10. UI/UX for Custom Interface Mode

### 10.1 Top-level Layout

**[v0 IMPLEMENTED]**

- **Left sidebar:** Projects, Runs, Orchestrators, Agent sessions, Docs tree
- **Main canvas:** Graph view (default)
- **Right inspector:** Node details
- **Bottom panel (tabbed):** Raw Console, Artifacts, Logs/Events, Verification

### 10.2 Graph View Requirements

**[v0 IMPLEMENTED]**

Node types (icons/shape differences):
- Orchestrator node
- Agent node (Codex / Claude / Gemini)
- Verification node (tests/lint/build)
- Docs node (doc update / doc review)
- Tool node (git operations, file ops)

Edges:
- handoff (orchestrator → agent)
- dependency (task DAG)
- result (agent → orchestrator)
- verification (execute → verify)
- doc_sync (any → docs)

Interaction:
- click node → inspector shows context pack, transcript, structured outputs, artifacts, event stream
- hover edge → show reason

### 10.3 Raw Console Tab

**[v0 IMPLEMENTED]**

For each agent session:
- Embedded console output (CLI interaction)
- Show session identity (Codex thread ID, Claude session_id, Gemini session id)
- Allow user to type directly (interactive mode), copy/paste outputs

### 10.4 Custom Interface Mode (non-PTY)

**[v0 IMPLEMENTED]**

Instead of raw terminal, you show:
- Chat bubbles (assistant/user/tool)
- Streaming chunks
- Tool calls as structured cards
- Approvals as explicit UI prompts
- "Rationale summaries" as a small collapsible block

### 10.5 AUTO/INTERACTIVE UX

**[v0 IMPLEMENTED]**

Global toggle with states:
- AUTO (green)
- INTERACTIVE (yellow, "automation paused" banner)

When entering INTERACTIVE:
- show which nodes are still "RUNNING" vs "PAUSED"

When returning to AUTO:
- orchestrator ingests changes and continues

---

## 11. Roadmap Notes

### v1 (Near-term)

- Git worktree isolation for parallel write tasks
- Unified "Context Pack Builder" agent with RAG retrieval
- First-class "Acceptance Checklist" UI with auto-checks
- Full DOCS_ITERATION pipeline with specialized doc agents
- Claude Agent SDK integration
- OpenAI Agents SDK for orchestrator
- Multi-orchestrator nesting (subgraphs)
- True DAG execution with race/consensus strategies
- Merge automation for worktrees
- Timeline view in UI

### v2 (Mid-term)

- Dynamic multi-orchestrator decomposition (meta-orchestrator spawns orchestrators per subsystem)
- Conflict-aware merge assistant
- Provider-agnostic tool-call normalization (closer to a common MCP-like tool layer)
- Remote runners + team mode
- GitHub/Linear/Slack integrations
- Deterministic replay + crash recovery
- Policy packs (allowed commands, path allowlists, network restrictions)

### v3 (Stretch)

- Distributed runners (remote agent sessions)
- Richer verification: fuzzing, property tests, security scans
- Policy packs (teams can encode rules/permissions centrally)
- Orchestration IDE with graph editing
- Time-travel debugging
- Skill libraries

---

## 12. Implementation Status Summary

| Feature | Status |
|---------|--------|
| Run phases (BOOT, INVESTIGATE, PLAN, EXECUTE, VERIFY, DONE) | **[v0 IMPLEMENTED]** |
| Run phases (DOCS_ITERATION, DOCS_SYNC) | **[v0 PARTIAL]** |
| AUTO/INTERACTIVE mode toggle | **[v0 IMPLEMENTED]** |
| Pause/Resume semantics | **[v0 IMPLEMENTED]** |
| Codex CLI adapter | **[v0 IMPLEMENTED]** |
| Claude Code CLI adapter | **[v0 IMPLEMENTED]** |
| Gemini CLI adapter | **[v0 IMPLEMENTED]** |
| Claude Agent SDK adapter | **[v1 PLANNED]** |
| Session continuity (all providers) | **[v0 IMPLEMENTED]** |
| AGENTS.md / CLAUDE.md injection | **[v0 IMPLEMENTED]** |
| Event-sourced state store | **[v0 IMPLEMENTED]** |
| WebSocket event streaming | **[v0 IMPLEMENTED]** |
| Graph UI with Cytoscape | **[v0 IMPLEMENTED]** |
| Node inspector | **[v0 IMPLEMENTED]** |
| Approval queue UI | **[v0 IMPLEMENTED]** |
| Prompt queue | **[v0 IMPLEMENTED]** |
| Chat API | **[v0 IMPLEMENTED]** |
| Manual node/edge creation | **[v0 IMPLEMENTED]** |
| Manual turn control | **[v0 IMPLEMENTED]** |
| Verification commands | **[v0 IMPLEMENTED]** |
| Context pack builder | **[v0 PARTIAL]** |
| Full doc iteration pipeline | **[v1 PLANNED]** |
| GPT-5.2 Pro doc reviewer | **[v1 PLANNED]** |
| Git worktree isolation | **[v1 PLANNED]** |
| Multi-orchestrator nesting | **[v1 PLANNED]** |
| OpenAI Agents SDK integration | **[v1 PLANNED]** |
| Remote runners | **[v2 PLANNED]** |
| Policy packs | **[v2 PLANNED]** |
