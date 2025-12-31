---
name: Agentic chat sessions + tool loop
owner: you
status: draft
---

# Goal

Add session-based chat to the harness with an agentic tool loop that can
autonomously edit code, run verification, and stream events to CLI/TUI/Web
clients. Define a concrete API and event schema, plus a core agent loop and
tool registry design tied to ai-kit.

# Non-goals

- UI implementation (CLI/TUI/Web are adapters only).
- Provider-specific tool formats beyond the ai-kit adapter.
- Full long-term memory system (summaries only in MVP).

# Constraints / nuances

- Local-first, daemon + thin client architecture stays intact.
- The agent loop is agentic: it can chain tools and retries without manual
  prompting, but approvals are enforced by policy.
- Patch review hooks exist but are **off by default**.
- All session events are append-only and streamable via SSE.
- Verification should run automatically after workspace writes when enabled.

# API

Base URL: `http://127.0.0.1:8787`

## Sessions

### POST /v1/sessions
Create a session and optionally prime it with a system prompt.

Request:
```json
{
  "workspace_path": "/abs/path/to/repo",
  "system_prompt": "Optional system instructions",
  "auto_run": true
}
```

Response:
```json
{"session_id":"sess_..."}
```

### GET /v1/sessions
List sessions (most recent first).

### GET /v1/sessions/{session_id}
Fetch session metadata and latest state.

### POST /v1/sessions/{session_id}/messages
Append a message and optionally trigger a turn.

Request:
```json
{
  "role": "user",
  "parts": [
    {"type":"text","text":"Please update the README."},
    {"type":"image","ref":"attachments/img_01.png","mime_type":"image/png"}
  ],
  "auto_run": true
}
```

Response:
```json
{"message_id":"msg_...","turn_id":"turn_..."}
```

### GET /v1/sessions/{session_id}/events
SSE stream of session events (history + live).

### POST /v1/sessions/{session_id}/approve
Approve or deny a gated tool call.

Request:
```json
{
  "turn_id":"turn_...",
  "tool_call_id":"call_...",
  "action":"approve",
  "reason":"ok"
}
```

### POST /v1/sessions/{session_id}/cancel
Cancel an active session turn.

### POST /v1/sessions/{session_id}/turns/{turn_id}/retry
Retry a failed turn using the same message context.

## Attachments

### POST /v1/sessions/{session_id}/attachments
Upload a small attachment (multipart or JSON base64).

Response:
```json
{"ref":"attachments/img_01.png","mime_type":"image/png"}
```

# Data model (server-side)

```
sessions/<session_id>/
  session.json
  events.ndjson
  attachments/
    <file>
  artifacts/
    <turn_id>/
      ...
```

## Session
```json
{
  "id": "sess_...",
  "created_at": "2025-01-01T00:00:00Z",
  "updated_at": "2025-01-01T00:00:00Z",
  "status": "active|waiting_approval|failed|completed|canceled",
  "workspace_path": "/abs/path/to/repo",
  "system_prompt": "...",
  "last_turn_id": "turn_..."
}
```

## Message
```json
{
  "id": "msg_...",
  "role": "system|user|assistant|tool",
  "parts": [
    {"type":"text","text":"..."},
    {"type":"image","ref":"attachments/img_01.png","mime_type":"image/png"},
    {"type":"audio","ref":"attachments/audio_01.wav","mime_type":"audio/wav"},
    {"type":"file","ref":"attachments/log_01.txt","mime_type":"text/plain"}
  ],
  "created_at": "2025-01-01T00:00:00Z"
}
```

## Tool call + result
```json
{
  "tool_call": {"id":"call_...","name":"shell","input":{"command":"make test"}},
  "tool_result": {"id":"call_...","ok":true,"parts":[{"type":"text","text":"ok"}]}
}
```

# Event schema (SSE)

Envelope:
```json
{
  "ts":"2025-01-01T00:00:00Z",
  "session_id":"sess_...",
  "turn_id":"turn_...",
  "type":"message_added",
  "data": {}
}
```

Event types (minimum set):
- `session_created`
- `message_added`
- `turn_started`
- `model_output_delta`
- `model_output_completed`
- `tool_call_started`
- `tool_call_completed`
- `approval_requested`
- `approval_granted`
- `approval_denied`
- `turn_completed`
- `session_completed`
- `session_failed`
- `session_canceled`

Notes:
- `model_output_delta` streams assistant text (and optionally structured data).
- `tool_call_*` events include tool name, call id, and input/output.
- `approval_*` events include tool name, call id, and optional reason.

# Agent loop (core behavior)

1. Load session + AGENTS.md + repo context bundle.
2. Resolve model via ai-kit registry + policy.
3. Stream `aikit.StreamGenerate` with messages + tool definitions.
4. When a tool call arrives, check policy and request approval if needed.
5. Execute tool via registry and stream back tool results as `tool` messages.
6. Repeat until the model emits a final assistant message or a stop signal.
7. If the workspace changed and `VerifyPolicy.AutoVerify` is enabled,
   run verification commands and, on failure, loop with failure context.
8. Persist events, artifacts, and final session state.

# Tool registry design (Go sketch)

```go
type ToolKind string

const (
  ToolKindRead   ToolKind = "read"
  ToolKindWrite  ToolKind = "write"
  ToolKindExec   ToolKind = "exec"
  ToolKindNet    ToolKind = "network"
)

type ToolDefinition struct {
  Name             string
  Description      string
  InputSchemaJSON  []byte
  Kind             ToolKind
  RequiresApproval bool
}

type ToolCall struct {
  ID    string
  Name  string
  Input json.RawMessage
}

type ToolResult struct {
  ID        string
  OK        bool
  Parts     []MessagePart
  Artifacts []string
  Error     string
}

type Tool interface {
  Definition() ToolDefinition
  Invoke(ctx context.Context, call ToolCall) (ToolResult, error)
}

type ToolRegistry interface {
  Definitions() []ToolDefinition
  Invoke(ctx context.Context, call ToolCall) (ToolResult, error)
}

type AikitAdapter interface {
  ToAikitTools(defs []ToolDefinition) []aikit.Tool
  FromAikitCall(call aikit.ToolCall) ToolCall
}
```

Default tools:
- `repo_tree`, `repo_map`, `read_file`, `search`, `git_status`
- `apply_patch` (write), `shell` (exec), `diagram` (exec)
- `verify` (exec; default command `make test` per AGENTS.md)

# Policy hooks

```
type VerifyPolicy struct {
  AutoVerify   bool
  Commands     []string // from AGENTS.md or spec
  RequireClean bool
}

type ApprovalPolicy struct {
  RequireForKinds []ToolKind
  RequireForTools []string
}

type PatchReviewPolicy struct {
  Mode string // "off" | "request" | "auto"
}
```

Defaults:
- `VerifyPolicy.AutoVerify = true`, `Commands = ["make test"]`
- `PatchReviewPolicy.Mode = "off"`

# Acceptance tests

- `POST /v1/sessions` returns a session id and creates `session.json`.
- `POST /v1/sessions/{id}/messages` emits `message_added` and `turn_started`.
- Tool calls emit `tool_call_started` and `tool_call_completed` events.
- Approvals gate tool execution when policy requires it.
- Verification runs after a write and emits events for command results.

# Roadmap (no estimates)

## MVP
- Session API + SSE events
- Basic tool registry + ai-kit adapter
- Workspace context bundle + auto-verify
- Approval gates for exec/write tools

## Phase 2
- Smarter context selection (file chunking, ranker)
- Patch previews + optional review hook
- Attachments and multimodal parts

## Phase 3
- Long-session summarization + memory pruning
- Multi-run orchestration (subtasks)
- Dashboard updates for chat UI

## Phase 4
- Remote tool runners
- Plugin SDK for external tools
- Team collaboration (shared sessions, handoff)
