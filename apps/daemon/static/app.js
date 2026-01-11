/* vuhlp code v0 UI (no build step) */

const $ = (sel) => document.querySelector(sel);

const runsListEl = $("#runsList");
const providersListEl = $("#providersList");
const connStatusEl = $("#connStatus");

const promptEl = $("#prompt");
const repoPathEl = $("#repoPath");
const createRunBtn = $("#createRunBtn");

const activeRunTitleEl = $("#activeRunTitle");
const activeRunMetaEl = $("#activeRunMeta");
const snapshotBtn = $("#snapshotBtn");
const stopRunBtn = $("#stopRunBtn");

const nodeInspectorEmpty = $("#nodeInspectorEmpty");
const nodeInspector = $("#nodeInspector");

const nodeIdEl = $("#nodeId");
const nodeTypeEl = $("#nodeType");
const nodeStatusEl = $("#nodeStatus");
const nodeProviderEl = $("#nodeProvider");
const nodeRoleEl = $("#nodeRole");
const nodeSummaryEl = $("#nodeSummary");
const nodeInputEl = $("#nodeInput");
const nodeOutputEl = $("#nodeOutput");
const nodeProgressEl = $("#nodeProgress");
const nodeArtifactsEl = $("#nodeArtifacts");

let ws = null;
let activeRunId = null;
let activeNodeId = null;

// Local state cache
const state = {
  runs: {}, // runId -> run snapshot
  nodeLogs: {}, // runId -> nodeId -> [lines]
};

// Cytoscape graph
const cy = cytoscape({
  container: document.getElementById("cy"),
  elements: [],
  style: [
    { selector: "node", style: { "label": "data(label)", "font-size": 10, "text-wrap": "wrap", "text-max-width": 120, "background-color": "#1f2937", "color": "#e6edf3", "border-width": 1, "border-color": "#334155" } },
    { selector: "edge", style: { "width": 1, "line-color": "#334155", "target-arrow-color": "#334155", "target-arrow-shape": "triangle", "curve-style": "bezier", "label": "data(label)", "font-size": 8, "color": "#8b949e" } },

    { selector: "node.status_queued", style: { "background-color": "#1f2937" } },
    { selector: "node.status_running", style: { "background-color": "#0f766e" } },
    { selector: "node.status_completed", style: { "background-color": "#14532d" } },
    { selector: "node.status_failed", style: { "background-color": "#7f1d1d" } },
    { selector: "node.status_skipped", style: { "background-color": "#374151" } },
  ],
  layout: { name: "breadthfirst", directed: true, padding: 24, spacingFactor: 1.2 }
});

cy.on("tap", "node", (evt) => {
  const node = evt.target;
  activeNodeId = node.id();
  renderNodeInspector();
});

function renderProviders(providers) {
  providersListEl.innerHTML = "";
  for (const p of providers) {
    const div = document.createElement("div");
    div.className = "providerItem";
    div.textContent = `${p.id} — ${p.displayName} (${p.kind})`;
    providersListEl.appendChild(div);
  }
}

function renderRunsList() {
  const runs = Object.values(state.runs);
  runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  runsListEl.innerHTML = "";
  for (const r of runs) {
    const item = document.createElement("div");
    item.className = "runItem" + (r.id === activeRunId ? " active" : "");
    item.onclick = () => selectRun(r.id);

    const title = document.createElement("div");
    title.textContent = `${r.id.slice(0, 8)} • ${r.status}`;
    const meta = document.createElement("div");
    meta.className = "runMeta";
    meta.textContent = new Date(r.createdAt).toLocaleString();

    const prompt = document.createElement("div");
    prompt.className = "runPrompt";
    prompt.textContent = r.prompt;

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(prompt);
    runsListEl.appendChild(item);
  }
}

function selectRun(runId) {
  activeRunId = runId;
  activeNodeId = null;
  renderRunsList();
  requestSnapshot(runId);
}

function rebuildGraph(run) {
  const elements = [];
  for (const node of Object.values(run.nodes || {})) {
    elements.push({
      data: { id: node.id, label: node.label },
      classes: `status_${node.status}`
    });
  }
  for (const edge of Object.values(run.edges || {})) {
    elements.push({
      data: { id: edge.id, source: edge.from, target: edge.to, label: edge.label || edge.type }
    });
  }

  cy.elements().remove();
  cy.add(elements);
  cy.layout({ name: "breadthfirst", directed: true, padding: 24, spacingFactor: 1.2 }).run();

  activeRunTitleEl.textContent = `Run ${run.id.slice(0, 8)} • ${run.status}`;
  activeRunMetaEl.textContent = `${run.repoPath || ""}`;
}

function applyEventToLocalState(ev) {
  const run = state.runs[ev.runId];
  if (!run) return;

  if (ev.type.startsWith("run.")) {
    Object.assign(run, ev.run);
    return;
  }

  if (ev.type.startsWith("node.")) {
    const nodeId = ev.nodeId;
    run.nodes = run.nodes || {};
    if (!run.nodes[nodeId]) run.nodes[nodeId] = { id: nodeId, label: nodeId, status: "queued" };
    if (ev.patch) Object.assign(run.nodes[nodeId], ev.patch);

    if (ev.type === "node.progress") {
      state.nodeLogs[ev.runId] = state.nodeLogs[ev.runId] || {};
      state.nodeLogs[ev.runId][nodeId] = state.nodeLogs[ev.runId][nodeId] || [];
      const line = `${new Date(ev.ts).toLocaleTimeString()} ${ev.message || ""}`;
      state.nodeLogs[ev.runId][nodeId].push(line);
      // cap
      if (state.nodeLogs[ev.runId][nodeId].length > 300) {
        state.nodeLogs[ev.runId][nodeId] = state.nodeLogs[ev.runId][nodeId].slice(-300);
      }
    }
    return;
  }

  if (ev.type === "edge.created") {
    run.edges = run.edges || {};
    run.edges[ev.edge.id] = ev.edge;
    return;
  }

  if (ev.type === "artifact.created") {
    run.artifacts = run.artifacts || {};
    run.artifacts[ev.artifact.id] = ev.artifact;
    return;
  }

  if (ev.type === "verification.completed") {
    const nodeId = ev.nodeId;
    run.nodes[nodeId] = run.nodes[nodeId] || { id: nodeId, label: nodeId, status: "queued" };
    run.nodes[nodeId].output = ev.report;
    return;
  }
}

function renderNodeInspector() {
  const run = state.runs[activeRunId];
  if (!run || !activeNodeId) {
    nodeInspectorEmpty.classList.remove("hidden");
    nodeInspector.classList.add("hidden");
    return;
  }
  const node = run.nodes?.[activeNodeId];
  if (!node) return;

  nodeInspectorEmpty.classList.add("hidden");
  nodeInspector.classList.remove("hidden");

  nodeIdEl.textContent = node.id;
  nodeTypeEl.textContent = node.type || "";
  nodeStatusEl.textContent = node.status || "";
  nodeProviderEl.textContent = node.providerId || "";
  nodeRoleEl.textContent = node.role || "";
  nodeSummaryEl.textContent = node.summary || "";

  nodeInputEl.textContent = safeJson(node.input);
  nodeOutputEl.textContent = safeJson(node.output);

  // progress logs
  const lines = (state.nodeLogs[activeRunId]?.[activeNodeId]) || [];
  nodeProgressEl.innerHTML = "";
  for (const l of lines.slice(-200)) {
    const div = document.createElement("div");
    div.className = "logLine";
    div.textContent = l;
    nodeProgressEl.appendChild(div);
  }

  // artifacts
  nodeArtifactsEl.innerHTML = "";
  const arts = Object.values(run.artifacts || {}).filter(a => a.nodeId === activeNodeId);
  arts.sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (!arts.length) {
    const div = document.createElement("div");
    div.className = "hint";
    div.textContent = "No artifacts for this node.";
    nodeArtifactsEl.appendChild(div);
  } else {
    for (const a of arts) {
      const link = document.createElement("a");
      link.className = "artifactLink";
      link.href = `/api/runs/${run.id}/artifacts/${a.id}/download`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = `${a.kind}: ${a.name}`;
      nodeArtifactsEl.appendChild(link);
    }
  }
}

function safeJson(obj) {
  if (obj === undefined) return "";
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

async function httpGet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}
async function httpPost(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function refreshProviders() {
  const data = await httpGet("/api/providers");
  renderProviders(data.providers || []);
}

async function refreshRuns() {
  const data = await httpGet("/api/runs");
  for (const run of data.runs || []) state.runs[run.id] = run;
  renderRunsList();
}

async function requestSnapshot(runId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "snapshot", runId }));
  } else {
    // fallback REST
    const data = await httpGet(`/api/runs/${runId}`);
    state.runs[runId] = data.run;
    rebuildGraph(data.run);
    renderNodeInspector();
  }
}

function connectWs() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    connStatusEl.textContent = "connected";
    ws.send(JSON.stringify({ type: "subscribe", runId: "*" }));
  };
  ws.onclose = () => {
    connStatusEl.textContent = "disconnected (retrying)";
    setTimeout(connectWs, 1200);
  };
  ws.onerror = () => {
    connStatusEl.textContent = "error";
  };
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "hello") {
      connStatusEl.textContent = "connected";
      // merge runs
      for (const r of msg.runs || []) {
        state.runs[r.id] = { ...(state.runs[r.id] || {}), ...r };
      }
      renderRunsList();
    } else if (msg.type === "snapshot") {
      state.runs[msg.run.id] = msg.run;
      if (msg.run.id === activeRunId) {
        rebuildGraph(msg.run);
        renderNodeInspector();
      }
      renderRunsList();
    } else if (msg.type === "event") {
      // Ensure run exists locally
      state.runs[msg.event.runId] = state.runs[msg.event.runId] || { id: msg.event.runId, nodes: {}, edges: {}, artifacts: {} };
      applyEventToLocalState(msg.event);

      if (msg.event.runId === activeRunId) {
        // update cy elements incrementally (simple approach: rebuild on structural events)
        if (msg.event.type === "node.created" || msg.event.type === "edge.created" || msg.event.type === "artifact.created") {
          rebuildGraph(state.runs[activeRunId]);
        } else if (msg.event.type.startsWith("node.")) {
          const node = state.runs[activeRunId].nodes[msg.event.nodeId];
          if (node) {
            const cyNode = cy.getElementById(msg.event.nodeId);
            if (cyNode) {
              cyNode.data("label", node.label);
              cyNode.classes(`status_${node.status}`);
            }
          }
        } else if (msg.event.type.startsWith("run.")) {
          activeRunTitleEl.textContent = `Run ${activeRunId.slice(0, 8)} • ${state.runs[activeRunId].status}`;
        }

        if (activeNodeId) renderNodeInspector();
      }
      renderRunsList();
    }
  };
}

createRunBtn.onclick = async () => {
  const prompt = (promptEl.value || "").trim();
  const repoPath = (repoPathEl.value || "").trim();
  if (!prompt) {
    alert("Prompt is required.");
    return;
  }
  createRunBtn.disabled = true;
  try {
    const data = await httpPost("/api/runs", { prompt, repoPath });
    state.runs[data.runId] = data.run;
    selectRun(data.runId);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "subscribe", runId: data.runId }));
  } catch (e) {
    alert(e.message || String(e));
  } finally {
    createRunBtn.disabled = false;
  }
};

snapshotBtn.onclick = async () => {
  if (!activeRunId) return;
  await requestSnapshot(activeRunId);
};

stopRunBtn.onclick = async () => {
  if (!activeRunId) return;
  await httpPost(`/api/runs/${activeRunId}/stop`, {});
};

// boot
(async function boot() {
  await refreshProviders();
  await refreshRuns();
  connectWs();
})();
