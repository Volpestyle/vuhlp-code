package api

import (
	"fmt"
	"net/http"
	"strings"
)

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	// Only serve UI at "/" and "/ui" to avoid intercepting API routes.
	if r.URL.Path != "/" && !strings.HasPrefix(r.URL.Path, "/ui") {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = fmt.Fprint(w, dashboardHTML)
}

const dashboardHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Agent Harness</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; }
    header { padding: 12px 16px; border-bottom: 1px solid #ddd; position: sticky; top: 0; background: #fff; }
    main { display: grid; grid-template-columns: 360px 1fr; gap: 12px; padding: 12px; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; }
    .runs { max-height: 70vh; overflow: auto; }
    .events { max-height: 70vh; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre-wrap; }
    button { padding: 6px 10px; border: 1px solid #ccc; border-radius: 6px; background: #f7f7f7; cursor: pointer; }
    input { padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; width: 100%; }
    .row { display: flex; gap: 8px; }
    .muted { color: #666; font-size: 12px; }
    .run { padding: 8px; border-radius: 6px; cursor: pointer; }
    .run:hover { background: #f3f3f3; }
    .run.active { background: #eaeaea; }
  </style>
</head>
<body>
<header>
  <div><strong>Agent Harness</strong> <span class="muted">live runs + approvals</span></div>
  <div class="muted">API: <code id="baseUrl"></code></div>
</header>

<main>
  <section class="card">
    <div class="row" style="justify-content: space-between; align-items: center;">
      <div><strong>Runs</strong></div>
      <button onclick="refreshRuns()">Refresh</button>
    </div>
    <div id="runs" class="runs"></div>
  </section>

  <section class="card">
    <div class="row" style="justify-content: space-between; align-items: center;">
      <div>
        <strong id="runTitle">Events</strong>
        <div class="muted" id="runMeta"></div>
      </div>
      <button onclick="clearEvents()">Clear</button>
    </div>

    <div class="row" style="margin-top: 10px;">
      <input id="stepId" placeholder="step_id to approve" />
      <button onclick="approveStep()">Approve</button>
    </div>

    <div id="events" class="events" style="margin-top: 10px;"></div>
  </section>
</main>

<script>
  const baseUrl = window.location.origin;
  document.getElementById("baseUrl").textContent = baseUrl;

  let selectedRun = null;
  let es = null;

  function el(tag, attrs={}, text="") {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k,v]) => e.setAttribute(k, v));
    if (text) e.textContent = text;
    return e;
  }

  async function refreshRuns() {
    const res = await fetch(baseUrl + "/v1/runs");
    const runs = await res.json();
    const container = document.getElementById("runs");
    container.innerHTML = "";
    runs.forEach(r => {
      const item = el("div", {class: "run" + (selectedRun && selectedRun.id === r.id ? " active" : "")});
      item.appendChild(el("div", {}, r.id));
      item.appendChild(el("div", {class:"muted"}, r.status + " • " + (r.model_canonical || "model: -")));
      item.appendChild(el("div", {class:"muted"}, r.spec_path));
      item.onclick = () => selectRun(r);
      container.appendChild(item);
    });
  }

  function clearEvents() {
    document.getElementById("events").textContent = "";
  }

  function appendEvent(ev) {
    const line = "[" + ev.ts + "] " + ev.type + " " + (ev.message || "");
    const pre = document.getElementById("events");
    pre.textContent += line + "\\n";
    pre.scrollTop = pre.scrollHeight;
  }

  function selectRun(r) {
    selectedRun = r;
    document.getElementById("runTitle").textContent = "Events • " + r.id;
    document.getElementById("runMeta").textContent = r.workspace_path;

    if (es) { es.close(); es = null; }
    clearEvents();
    es = new EventSource(baseUrl + "/v1/runs/" + r.id + "/events");
    es.onmessage = (m) => {
      try { appendEvent(JSON.parse(m.data)); } catch (e) {}
    };
    es.onerror = () => { /* keep trying */ };
    refreshRuns();
  }

  async function approveStep() {
    if (!selectedRun) return alert("select a run first");
    const stepId = document.getElementById("stepId").value.trim();
    if (!stepId) return alert("enter step_id");
    const res = await fetch(baseUrl + "/v1/runs/" + selectedRun.id + "/approve", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({step_id: stepId}),
    });
    if (!res.ok) {
      const txt = await res.text();
      alert("approve failed: " + txt);
    } else {
      document.getElementById("stepId").value = "";
    }
  }

  refreshRuns();
  setInterval(refreshRuns, 5000);
</script>
</body>
</html>`;
