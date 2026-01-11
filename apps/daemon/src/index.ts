import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

import { loadConfig } from "./config.js";
import { RunStore } from "./core/store.js";
import { EventBus } from "./core/eventBus.js";
import { ProviderRegistry } from "./providers/registry.js";
import { WorkspaceManager } from "./core/workspace.js";
import { OrchestratorEngine } from "./core/orchestrator.js";
import { nowIso } from "./core/time.js";

type WsClientState = {
  runIds: Set<string>;
};

const cfg = loadConfig();
const store = new RunStore({ dataDir: cfg.dataDir! });
const bus = new EventBus(store);
const providers = new ProviderRegistry(cfg.providers!);
const workspace = new WorkspaceManager({
  mode: cfg.workspace!.mode ?? "shared",
  rootDir: cfg.workspace!.rootDir ?? ".vuhlp/workspaces",
});
const orchestrator = new OrchestratorEngine({
  store,
  bus,
  providers,
  workspace,
  cfg: {
    roles: cfg.roles!,
    scheduler: { maxConcurrency: cfg.scheduler!.maxConcurrency ?? 3 },
    orchestration: { maxIterations: cfg.orchestration!.maxIterations ?? 3 },
    verification: { commands: cfg.verification!.commands ?? [] },
  },
});

// --- HTTP server ---
const app = express();
app.use(express.json({ limit: "2mb" }));

// Static UI
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.resolve(__dirname, "..", "static");
app.use("/", express.static(staticDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true, now: nowIso(), dataDir: store.getDataDir() });
});

app.get("/api/providers", async (_req, res) => {
  const list = providers.list().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    kind: p.kind,
    capabilities: p.capabilities,
  }));
  res.json({ providers: list });
});

app.get("/api/runs", (_req, res) => {
  res.json({ runs: store.listRuns() });
});

app.post("/api/runs", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  const repoPath = String(req.body?.repoPath ?? process.cwd()).trim();
  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  const run = store.createRun({
    prompt,
    repoPath,
    maxIterations: cfg.orchestration!.maxIterations ?? 3,
    config: cfg as any,
  });

  // Kick off the run asynchronously (within process).
  orchestrator.startRun(run.id).catch((e) => {
    bus.emitRunPatch(run.id, { id: run.id, status: "failed" }, "run.failed");
    bus.emitNodeProgress(run.id, run.rootOrchestratorNodeId, `Run crashed: ${e?.message ?? String(e)}`, { error: e });
  });

  res.json({ runId: run.id, run });
});

app.get("/api/runs/:runId", (req, res) => {
  const run = store.getRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json({ run });
});

app.post("/api/runs/:runId/stop", (req, res) => {
  const ok = orchestrator.stopRun(req.params.runId);
  res.json({ ok });
});

app.get("/api/runs/:runId/artifacts/:artifactId/download", (req, res) => {
  const run = store.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "run not found" });

  const art = run.artifacts[req.params.artifactId];
  if (!art) return res.status(404).json({ error: "artifact not found" });

  if (!fs.existsSync(art.path)) return res.status(404).json({ error: "artifact file missing on disk" });

  res.setHeader("Content-Type", art.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename=\"${art.name}\"`);
  res.sendFile(art.path);
});

// --- WS server ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const wsState = new Map<WebSocket, WsClientState>();

function wsSend(ws: WebSocket, msg: any) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // ignore
  }
}

wss.on("connection", (ws) => {
  wsState.set(ws, { runIds: new Set() });

  wsSend(ws, {
    type: "hello",
    now: nowIso(),
    runs: store.listRuns().map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt, prompt: r.prompt })),
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg.type === "subscribe") {
        const st = wsState.get(ws);
        if (!st) return;
        if (msg.runId === "*") {
          st.runIds.add("*");
        } else if (typeof msg.runId === "string") {
          st.runIds.add(msg.runId);
        }
        wsSend(ws, { type: "subscribed", runIds: [...st.runIds] });
      } else if (msg.type === "snapshot") {
        const run = store.getRun(String(msg.runId));
        if (run) wsSend(ws, { type: "snapshot", run });
      }
    } catch (e: any) {
      wsSend(ws, { type: "error", message: e?.message ?? String(e) });
    }
  });

  ws.on("close", () => {
    wsState.delete(ws);
  });
});

bus.subscribe((event) => {
  for (const [ws, st] of wsState.entries()) {
    if (ws.readyState !== ws.OPEN) continue;
    if (st.runIds.has("*") || st.runIds.has(event.runId)) {
      wsSend(ws, { type: "event", event });
    }
  }
});

server.listen(cfg.server!.port, () => {
  console.log(`[vuhlp] daemon listening on http://localhost:${cfg.server!.port}`);
  console.log(`[vuhlp] dataDir: ${store.getDataDir()}`);
});
