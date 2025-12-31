# HTTP API (agentd)

Base URL: `http://127.0.0.1:8787` (configurable)

If `HARNESS_AUTH_TOKEN` is set, all requests require:

```
Authorization: Bearer <token>
```

---

## GET /

Dashboard UI.

---

## POST /v1/runs

Create and start a run.

Request body:
```json
{
  "workspace_path": "/abs/path/to/repo",
  "spec_path": "/abs/path/to/spec.md"
}
```

Response:
```json
{
  "run_id": "run_..."
}
```

---

## GET /v1/runs

List runs (most recent first).

---

## GET /v1/runs/{run_id}

Get run metadata/state.

---

## GET /v1/runs/{run_id}/events

Server-Sent Events (SSE) stream of run events.

Events are sent as JSON lines.

Example:

```
event: message
data: {"ts":"...","type":"log","message":"..."}
```

---

## POST /v1/runs/{run_id}/approve

Approve a gated step.

Request body:
```json
{"step_id":"step_..."}
```

---

## POST /v1/runs/{run_id}/cancel

Cancel a run.

---

## GET /v1/runs/{run_id}/export

Downloads a zip artifact that includes:
- run.json
- events.ndjson
- artifacts/ (if present)

---

# Sessions (chat)

## POST /v1/sessions

Create a chat session.

Request body:
```json
{
  "workspace_path": "/abs/path/to/repo",
  "system_prompt": "Optional system instructions",
  "auto_run": true,
  "mode": "chat",
  "spec_path": "specs/my-feature/spec.md"
}
```

Response:
```json
{"session_id":"sess_...","spec_path":"/abs/path/to/repo/specs/session-sess_.../spec.md"}
```

## GET /v1/sessions

List sessions (most recent first).

## GET /v1/sessions/{session_id}

Fetch session metadata and latest state.

## POST /v1/sessions/{session_id}/messages

Append a message and optionally start a turn.

Request body:
```json
{
  "role": "user",
  "parts": [
    {"type":"text","text":"Please update the README."},
    {"type":"image","ref":"attachments/ui.png","mime_type":"image/png"}
  ],
  "auto_run": true
}
```

Response:
```json
{"message_id":"msg_...","turn_id":"turn_..."}
```

## GET /v1/sessions/{session_id}/events

SSE stream of session events.

## POST /v1/sessions/{session_id}/mode

Update the session mode (chat or spec). If switching to spec mode without
spec_path, a draft spec is created under specs/session-<id>/spec.md.

Request body:
```json
{
  "mode": "spec",
  "spec_path": "specs/my-feature/spec.md"
}
```

Response:
```json
{"session_id":"sess_...","mode":"spec","spec_path":"/abs/path/to/repo/specs/my-feature/spec.md"}
```

## POST /v1/sessions/{session_id}/approve

Approve or deny a gated tool call.

Request body:
```json
{
  "turn_id":"turn_...",
  "tool_call_id":"call_...",
  "action":"approve",
  "reason":"ok"
}
```

## POST /v1/sessions/{session_id}/cancel

Cancel an active turn.

## POST /v1/sessions/{session_id}/turns/{turn_id}/retry

Retry a failed turn.

## POST /v1/sessions/{session_id}/attachments

Upload an attachment (multipart or base64 JSON).

Response:
```json
{"ref":"attachments/ui.png","mime_type":"image/png"}
```

---

# Specs

## POST /v1/specs/generate

Generate and write a spec file from a prompt.

Request body:
```json
{
  "workspace_path": "/abs/path/to/repo",
  "spec_name": "my-feature",
  "prompt": "Add a CLI command to ...",
  "overwrite": false
}
```

Response:
```json
{"spec_path":"/abs/path/to/repo/specs/my-feature/spec.md","content":"..."}
```

---

# Models

## GET /v1/models

List model records from ai-kit and return the current model policy.

Response:
```json
{
  "models": [/* model records */],
  "policy": {
    "require_tools": false,
    "require_vision": false,
    "max_cost_usd": 5,
    "preferred_models": ["openai:gpt-4o-mini"]
  }
}
```

## GET /v1/model-policy

Get the current model policy.

## POST /v1/model-policy

Update the model policy.

Request:
```json
{
  "require_tools": false,
  "require_vision": false,
  "max_cost_usd": 5,
  "preferred_models": ["openai:gpt-4o-mini"]
}
```
