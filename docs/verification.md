1) Quick sanity: server + UI wiring

A) Health

Open in browser:
	•	GET /health → should return JSON with ok: true

Or:

curl -s http://localhost:4317/health

B) UI loads and connects to WS

Open:
	•	http://localhost:4317/

What to look for:
	•	Graph canvas renders
	•	It shows “connected” / starts receiving events once you start a run
	•	(If your UI exposes connection state) it should connect to WebSocket at:
	•	ws://localhost:4317/ws

⸻

2) Provider registry matches config

Route
	•	GET /api/providers

curl -s http://localhost:4317/api/providers | jq

What to verify:
	•	You see providers like mock, codex-cli, claude-cli, gemini-cli
	•	The defaults match your apps/daemon/vuhlp.config.json

This checks “adapter registry + config loading” alignment.

⸻

3) Runs: create, observe graph, stop

A) List runs (empty → then grows)
	•	GET /api/runs

curl -s http://localhost:4317/api/runs | jq

B) Create a run
	•	POST /api/runs

In v0, the easiest way to validate the loop is to start with mock so it works without external CLIs:

curl -s -X POST http://localhost:4317/api/runs \
  -H "content-type: application/json" \
  -d '{
    "title": "alignment-test",
    "goal": "Implement a small feature and verify it",
    "providerPreset": "mock"
  }' | jq

What to verify in the UI:
	•	A new run appears
	•	Graph populates with the core phases (investigate/plan/implement/verify/doc-ish steps depending on your v0)
	•	Nodes transition through states (queued → running → completed/failed)
	•	Clicking nodes shows their context/output (whatever v0 exposes)

C) Get run details
	•	GET /api/runs/:runId

curl -s http://localhost:4317/api/runs/<RUN_ID> | jq

What to verify:
	•	Node list + statuses match what you see in UI
	•	Artifacts are listed (diff/log/report)

D) Stop a run
	•	POST /api/runs/:runId/stop

curl -s -X POST http://localhost:4317/api/runs/<RUN_ID>/stop | jq

What to verify:
	•	UI updates immediately (via WS) and run stops scheduling more work

⸻

4) Artifact download path works (docs ↔ reality)

When a run produces artifacts (logs/diffs/reports), test:
	•	GET /api/runs/:runId/artifacts/:artifactId/download

curl -L -o artifact.bin \
  http://localhost:4317/api/runs/<RUN_ID>/artifacts/<ARTIFACT_ID>/download

What to verify:
	•	The downloaded artifact matches what node inspector claims
	•	This validates the “artifact store + API contract” part of your docs.

⸻

5) WebSocket event stream is canonical + deterministic enough for viz

Open a raw WS client (optional but useful):

npx wscat -c ws://localhost:4317/ws

What to verify:
	•	You see events streaming as JSON
	•	Event ordering makes sense: run created → node created → node started → progress → completed
	•	If you re-run the same scenario, event types and structure stay stable (even if timestamps differ)

This is the backbone of “deterministic viz from stored graph state.”

⸻

6) “Docs alignment” checks you can do right now in v0

Even before the more advanced semantics (join gates, loop stall detection, etc.) land, you can validate these doc promises:

A) Observability
	•	Every meaningful state change shows up:
	•	in UI
	•	in WS stream
	•	in /api/runs/:id

B) Reproducibility
	•	Run metadata + artifacts let you explain “what happened” without rerunning

C) Provider surface
	•	/api/providers enumerates capabilities (even if minimal today)

⸻

The exact routes you can test (v0)

These are the routes present in the v0 daemon:
	•	GET  /health
	•	GET  /api/providers
	•	GET  /api/runs
	•	POST /api/runs
	•	GET  /api/runs/:runId
	•	POST /api/runs/:runId/stop
	•	GET  /api/runs/:runId/artifacts/:artifactId/download
	•	WS   /ws

⸻

If you tell me what you’ve implemented beyond v0 (especially Auto/Interactive mode toggle, join gates, loop safety), I can give you a second checklist of specific “this should happen, then that should happen” tests that directly validate those newer docs (e.g., “switch to interactive mid-run halts scheduling after current turn boundary,” “JoinGate waits for both workers,” “loop halts on non-progress”).