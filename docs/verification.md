1) Daemon + UI wiring

A) Daemon reachable

curl -s http://localhost:4000/api/runs | jq

B) UI loads and connects

- UI dev server: http://localhost:5173
- Daemon WebSocket: ws://localhost:4000/ws

What to verify:
- Graph canvas renders
- WebSocket connects and receives events once a run starts

---

2) Runs + nodes

A) Create a run

curl -s -X POST http://localhost:4000/api/runs \
  -H "content-type: application/json" \
  -d '{
    "mode": "INTERACTIVE",
    "globalMode": "PLANNING",
    "cwd": "."
  }' | jq

B) Create a node

curl -s -X POST http://localhost:4000/api/runs/<RUN_ID>/nodes \
  -H "content-type: application/json" \
  -d '{
    "node": {
      "label": "Planner",
      "provider": "claude",
      "roleTemplate": "planner"
    }
  }' | jq

C) Send a message to the node

curl -s -X POST http://localhost:4000/api/runs/<RUN_ID>/chat \
  -H "content-type: application/json" \
  -d '{
    "nodeId": "<NODE_ID>",
    "content": "Summarize this repo",
    "interrupt": false
  }' | jq

---

3) Artifact fetch

GET /api/runs/:runId/artifacts/:artifactId

curl -s http://localhost:4000/api/runs/<RUN_ID>/artifacts/<ARTIFACT_ID> | jq

---

4) WebSocket event stream

npx wscat -c ws://localhost:4000/ws?runId=<RUN_ID>

What to verify:
- Events arrive as JSON objects
- Types include run/node lifecycle, messages, tools, approvals, handoffs

---

Routes present in v0

- GET  /api/fs/list
- POST /api/runs
- GET  /api/runs
- GET  /api/runs/:runId
- PATCH /api/runs/:runId
- DELETE /api/runs/:runId
- GET  /api/runs/:runId/events
- POST /api/runs/:runId/nodes
- PATCH /api/runs/:runId/nodes/:nodeId
- DELETE /api/runs/:runId/nodes/:nodeId
- POST /api/runs/:runId/nodes/:nodeId/reset
- POST /api/runs/:runId/nodes/:nodeId/start
- POST /api/runs/:runId/nodes/:nodeId/stop
- POST /api/runs/:runId/nodes/:nodeId/interrupt
- POST /api/runs/:runId/edges
- DELETE /api/runs/:runId/edges/:edgeId
- POST /api/runs/:runId/chat
- GET  /api/runs/:runId/artifacts/:artifactId
- GET  /api/approvals
- POST /api/approvals/:id/resolve
- WS   /ws?runId=<RUN_ID>
