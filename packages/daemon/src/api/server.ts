import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import type { Runtime } from "../runtime/runtime.js";
import type {
  CreateEdgeRequest,
  CreateNodeRequest,
  CreateRunRequest,
  PostChatRequest,
  ResolveApprovalRequest,
  UpdateRunRequest,
  UpdateNodeRequest
} from "@vuhlp/contracts";

export function createServer(runtime: Runtime): http.Server {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.post("/api/runs", (req, res) => {
    const body = req.body as CreateRunRequest;
    const run = runtime.createRun({
      mode: body?.mode,
      globalMode: body?.globalMode
    });
    res.json({ run });
  });

  app.get("/api/runs", (_req, res) => {
    res.json({ runs: runtime.listRuns() });
  });

  app.get("/api/runs/:id", (req, res) => {
    try {
      const run = runtime.getRun(req.params.id);
      res.json({ run });
    } catch (error) {
      res.status(404).json({ error: String(error) });
    }
  });

  app.patch("/api/runs/:id", (req, res) => {
    try {
      const body = req.body as UpdateRunRequest;
      const run = runtime.updateRun(req.params.id, body.patch ?? {});
      res.json({ run });
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  app.get("/api/runs/:id/events", async (req, res) => {
    try {
      const events = await runtime.getEvents(req.params.id);
      res.json({ events });
    } catch (error) {
      res.status(404).json({ error: String(error) });
    }
  });

  app.delete("/api/runs/:id", async (req, res) => {
    try {
      await runtime.deleteRun(req.params.id);
      res.json({ runId: req.params.id });
    } catch (error) {
      res.status(404).json({ error: String(error) });
    }
  });

  app.post("/api/runs/:id/nodes", (req, res) => {
    try {
      const body = req.body as CreateNodeRequest;
      const node = runtime.createNode(req.params.id, body.node);
      res.json({ node });
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  app.patch("/api/runs/:id/nodes/:nodeId", (req, res) => {
    try {
      const body = req.body as UpdateNodeRequest;
      const node = runtime.updateNode(req.params.id, req.params.nodeId, body.patch ?? {}, body.config);
      res.json({ node });
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  app.delete("/api/runs/:id/nodes/:nodeId", async (req, res) => {
    try {
      await runtime.deleteNode(req.params.id, req.params.nodeId);
      res.json({ nodeId: req.params.nodeId });
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  app.post("/api/runs/:id/nodes/:nodeId/reset", async (req, res) => {
    try {
      await runtime.resetNode(req.params.id, req.params.nodeId);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  app.get("/api/runs/:id/artifacts/:artifactId", async (req, res) => {
    try {
      const result = await runtime.getArtifactContent(req.params.id, req.params.artifactId);
      res.json(result);
    } catch (error) {
      res.status(404).json({ error: String(error) });
    }
  });

  app.post("/api/runs/:id/edges", (req, res) => {
    try {
      const body = req.body as CreateEdgeRequest;
      const edge = runtime.createEdge(req.params.id, body.edge);
      res.json({ edge });
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  app.delete("/api/runs/:id/edges/:edgeId", (req, res) => {
    try {
      runtime.deleteEdge(req.params.id, req.params.edgeId);
      res.json({ edgeId: req.params.edgeId });
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  app.post("/api/runs/:id/chat", (req, res) => {
    try {
      const body = req.body as PostChatRequest;
      const message = runtime.postMessage(req.params.id, body.nodeId, body.content, body.interrupt);
      res.json({ messageId: message.id });
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  app.get("/api/approvals", (_req, res) => {
    res.json({ approvals: runtime.listApprovals() });
  });

  app.post("/api/approvals/:id/resolve", (req, res) => {
    const body = req.body as ResolveApprovalRequest;
    try {
      if (body.runId) {
        runtime.resolveApproval(body.runId, req.params.id, body.resolution);
      } else {
        runtime.resolveApprovalById(req.params.id, body.resolution);
      }
      res.json({ approvalId: req.params.id, resolution: body.resolution });
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/ws", `http://${req.headers.host ?? "localhost"}`);
    const runId = url.searchParams.get("runId");
    const unsubscribe = runtime.onEvent((event) => {
      if (runId && event.runId !== runId) {
        return;
      }
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    });
    socket.on("close", () => unsubscribe());
  });

  return server;
}
