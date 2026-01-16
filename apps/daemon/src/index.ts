import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type Response } from "express";
import { WebSocketServer, WebSocket } from "ws";

import { initLogger, log } from "./core/logger.js";
import { loadConfig, saveConfig } from "./config.js";
import { RunStore } from "./core/store.js";
import { EventBus } from "./core/eventBus.js";
import { ProviderRegistry } from "./providers/registry.js";
import { WorkspaceManager } from "./core/workspace.js";
import { OrchestratorEngine } from "./core/orchestrator.js";
import { ApprovalQueue } from "./core/approvalQueue.js";
import { SessionRegistry } from "./core/sessionRegistry.js";
import { ChatManager } from "./core/chatManager.js";
import { PromptQueue } from "./core/promptQueue.js";
import { nowIso } from "./core/time.js";
import { ApprovalStatus, InteractionMode, RunMode, GlobalMode, NodeControl, RoleId } from "./core/types.js";

type WsClientState = {
  runIds: Set<string>;
};

let cfg = loadConfig();
initLogger(cfg.logging);

const store = new RunStore({ dataDir: cfg.dataDir! });
const bus = new EventBus(store);
const providers = new ProviderRegistry(cfg.providers!);
const workspace = new WorkspaceManager({
  mode: cfg.workspace!.mode ?? "shared",
  rootDir: cfg.workspace!.rootDir ?? ".vuhlp/workspaces",
});
const chatManager = new ChatManager(bus, store);
const promptQueue = new PromptQueue(bus);

// Approval queue for tool execution approvals
const approvalQueue = new ApprovalQueue(bus, {
  defaultTimeoutMs: 0, // No default timeout
  autoDenyOnTimeout: true,
});

// Session registry for provider session continuity
const sessionRegistry = new SessionRegistry(cfg.dataDir!);

const orchestrator = new OrchestratorEngine({
  store,
  bus,
  providers,
  workspace,
  chatManager,
  promptQueue,
  approvalQueue,
  sessionRegistry,
  cfg: {
    roles: cfg.roles!,
    scheduler: { maxConcurrency: cfg.scheduler!.maxConcurrency ?? 3 },
    orchestration: {
      maxIterations: cfg.orchestration!.maxIterations ?? 3,
      maxTurnsPerNode: cfg.orchestration!.maxTurnsPerNode ?? 2,
    },
    verification: { commands: cfg.verification!.commands ?? [] },
    planning: { docsDirectory: cfg.planning!.docsDirectory ?? "docs" },
    workspace: { cleanupOnDone: cfg.workspace!.cleanupOnDone ?? false },
  },
});

// --- HTTP server ---
const app = express();
app.use(express.json({ limit: "2mb" }));

// Static UI
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.resolve(__dirname, "..", "client", "dist");
app.use("/", express.static(staticDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true, now: nowIso(), dataDir: store.getDataDir() });
});

app.get("/api/config", (_req, res) => {
  res.json({ config: cfg });
});

app.post("/api/config", (req, res) => {
  try {
    saveConfig(req.body);
    // Reload config to apply changes where possible
    cfg = loadConfig();
    // Note: Deep re-init of components (providers, orchestrator) is not fully supported without restart
    // but we can update the orchestrator cfg reference if we make it public or re-instantiate.
    // For now, changes usually require restart, but we save them to disk.
    res.json({ ok: true, config: cfg });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/providers", async (_req, res) => {
  const list = await Promise.all(providers.list().map(async (p) => {
    let health;
    try {
      health = await p.healthCheck();
    } catch (e: any) {
      health = { ok: false, message: e.message };
    }
    return {
      id: p.id,
      displayName: p.displayName,
      kind: p.kind,
      capabilities: p.capabilities,
      health,
    };
  }));
  res.json({ providers: list });
});

app.get("/api/runs", (req, res) => {
  const includeArchived = req.query.includeArchived === "true";
  res.json({ runs: store.listRunsFiltered(includeArchived) });
});

app.post("/api/runs", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  const repoPath = String(req.body?.repoPath ?? process.cwd()).trim();
  const mode = (req.body?.mode as RunMode) ?? cfg.orchestration!.defaultRunMode ?? "AUTO";
  const globalMode = (req.body?.globalMode as GlobalMode) ?? "PLANNING";
  const policy = req.body?.policy;

  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  // Validate mode if provided
  if (mode && !["AUTO", "INTERACTIVE"].includes(mode)) {
    res.status(400).json({ error: "mode must be AUTO or INTERACTIVE" });
    return;
  }

  log.info("Creating new run", {
    promptLength: prompt.length,
    repoPath,
    mode,
    globalMode
  });

  const run = store.createRun({
    prompt,
    repoPath,
    maxIterations: cfg.orchestration!.maxIterations ?? 3,
    config: cfg as Record<string, unknown>,
    mode,
    globalMode,
    policy,
  });

  log.info("Run created", { runId: run.id, rootNodeId: run.rootOrchestratorNodeId });

  // Kick off the run asynchronously (within process).
  orchestrator.startRun(run.id).catch((e) => {
    log.error("Run crashed during startup", {
      runId: run.id,
      error: e instanceof Error ? e.message : String(e)
    });
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

// Create a new node
app.post("/api/runs/:runId/nodes", (req, res) => {
  const { runId } = req.params;
  const {
    providerId,
    label,
    role,
    parentNodeId,
    input,
    customSystemPrompt,
    policy,
  } = req.body;

  try {
    const node = orchestrator.spawnNode(runId, {
      providerId,
      label,
      role: role as RoleId | undefined,
      parentNodeId,
      input,
      customSystemPrompt,
      policy,
    });
    res.json({ ok: true, node });
  } catch (e: unknown) {
    const error = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: error.message });
  }
});

// Update a node (e.g. change provider)
app.patch("/api/runs/:runId/nodes/:nodeId", (req, res) => {
  const { runId, nodeId } = req.params;
  const updates = req.body; // e.g. { providerId: "claude" }

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  // Validate updates (basic security: unlikely to break things if we allow most fields)
  // But let's be explicitly permissive for now.
  const updatedNode = store.updateNode(runId, nodeId, updates);
  if (!updatedNode) {
    res.status(404).json({ error: "node not found" });
    return;
  }

  bus.emitNodePatch(runId, nodeId, updates, "node.progress");

  res.json({ ok: true, node: updatedNode });
});

app.post("/api/runs/:runId/stop", (req, res) => {
  const ok = orchestrator.stopRun(req.params.runId);
  res.json({ ok });
});

app.post("/api/runs/:runId/nodes/:nodeId/stop", (req, res) => {
  const ok = orchestrator.stopNode(req.params.runId, req.params.nodeId);
  res.json({ ok });
});

app.post("/api/runs/:runId/nodes/:nodeId/restart", (req, res) => {
  const ok = orchestrator.restartNode(req.params.runId, req.params.nodeId);
  res.json({ ok });
});

app.delete("/api/runs/:runId/nodes/:nodeId", (req, res) => {
  const { runId, nodeId } = req.params;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const node = run.nodes[nodeId];
  if (!node) {
    res.status(404).json({ error: "node not found" });
    return;
  }

  if (run.rootOrchestratorNodeId === nodeId) {
    res.status(400).json({ error: "cannot delete root orchestrator node" });
    return;
  }

  if (node.status === "running") {
    orchestrator.stopNode(runId, nodeId);
  }

  bus.emitNodeDeleted(runId, nodeId);
  res.json({ ok: true });
});

// Create an edge
app.post("/api/runs/:runId/edges", (req, res) => {
  const { runId } = req.params;
  const { sourceId, targetId, type } = req.body;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  // Validate nodes exist
  if (!run.nodes[sourceId] || !run.nodes[targetId]) {
    res.status(400).json({ error: "source or target node not found" });
    return;
  }

  const edgeId = req.body.id || crypto.randomUUID();
  const edge = {
    id: edgeId,
    runId,
    from: sourceId,
    to: targetId,
    type: type || "default",
    createdAt: nowIso(),
    bidirectional: true,
    deliveryPolicy: "queue" as const,
    pendingEnvelopes: [],
  };

  store.addEdge(runId, edge);
  bus.emitEdgeCreated(runId, edge);

  res.json({ ok: true, edge });
});

app.delete("/api/runs/:runId/edges/:edgeId", (req, res) => {
  const { runId, edgeId } = req.params;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const edge = store.removeEdge(runId, edgeId);
  if (!edge) {
    res.status(404).json({ error: "edge not found" });
    return;
  }

  bus.emitEdgeDeleted(runId, edgeId);
  res.json({ ok: true });
});

app.patch("/api/runs/:runId/edges/:edgeId", (req, res) => {
  const { runId, edgeId } = req.params;
  const updates = req.body;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const updatedEdge = store.updateEdge(runId, edgeId, updates);
  if (!updatedEdge) {
    res.status(404).json({ error: "edge not found" });
    return;
  }

  bus.emitEdgePatch(runId, edgeId, updates, "edge.updated");
  res.json({ ok: true, edge: updatedEdge });
});

// Archive a run (soft-delete)
app.post("/api/runs/:runId/archive", (req, res) => {
  const { runId } = req.params;

  // Stop the run first if it's active
  orchestrator.stopRun(runId);

  const run = store.archiveRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  res.json({ ok: true, run });
});

// Unarchive a run
app.post("/api/runs/:runId/unarchive", (req, res) => {
  const { runId } = req.params;

  const run = store.unarchiveRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  res.json({ ok: true, run });
});

// Update a run (rename, etc.)
app.patch("/api/runs/:runId", (req, res) => {
  const { runId } = req.params;
  const { name } = req.body as { name?: string };

  const run = store.renameRun(runId, name);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  res.json({ ok: true, run });
});

// Delete a single run (permanent)
app.delete("/api/runs/:runId", (req, res) => {
  const { runId } = req.params;

  // Stop the run first if it's active
  orchestrator.stopRun(runId);

  // Clean up related state
  chatManager.clearMessages(runId);
  chatManager.clearModes(runId);

  // Delete from store
  const deleted = store.deleteRun(runId);
  if (!deleted) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  res.json({ ok: true, runId });
});

// Delete multiple runs or clear all
app.delete("/api/runs", (req, res) => {
  const runIds = req.body?.runIds as string[] | undefined;

  if (runIds && Array.isArray(runIds)) {
    // Delete specific runs
    for (const runId of runIds) {
      orchestrator.stopRun(runId);
      chatManager.clearMessages(runId);
      chatManager.clearModes(runId);
    }
    const count = store.deleteRuns(runIds);
    res.json({ ok: true, deleted: count });
  } else {
    // Clear all runs
    const runs = store.listRuns();
    for (const run of runs) {
      orchestrator.stopRun(run.id);
      chatManager.clearMessages(run.id);
      chatManager.clearModes(run.id);
    }
    const count = store.clearAllRuns();
    res.json({ ok: true, deleted: count });
  }
});

app.post("/api/runs/:runId/pause", (req, res) => {
  const ok = orchestrator.pauseRun(req.params.runId);
  res.json({ ok });
});

app.post("/api/runs/:runId/resume", (req, res) => {
  const feedback = req.body?.feedback ? String(req.body.feedback) : undefined;
  const ok = orchestrator.resumeRun(req.params.runId, feedback);
  res.json({ ok });
});

app.post("/api/runs/:runId/policy/skip_cli_permissions", (req, res) => {
  const { skip } = req.body;
  if (typeof skip !== "boolean") {
    res.status(400).json({ error: "skip (boolean) is required" });
    return;
  }

  const run = store.getRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  // Update policy
  store.updateRun(run.id, {
    policy: {
      ...run.policy,
      skipCliPermissions: skip
    }
  });

  res.json({ ok: true, skip });
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

// Helper to expand tilde in paths
function expandPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

app.get("/api/system/fs", async (req, res) => {
  try {
    const rawPath = String(req.query.path || process.cwd());
    const currentPath = path.resolve(expandPath(rawPath));
    const includeFiles = req.query.includeFiles === "true";
    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

    const items = entries
      .filter((e) => {
        if (e.name.startsWith(".")) return false;
        if (includeFiles) return e.isDirectory() || e.isFile();
        return e.isDirectory();
      })
      .map((e) => ({
        name: e.name,
        path: path.join(currentPath, e.name),
        isDirectory: e.isDirectory(),
      }));

    // Sort: directories first, then files, alphabetically within each group
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    res.json({
      path: currentPath,
      parent: path.dirname(currentPath),
      entries: items,
    });
  } catch (e: unknown) {
    const err = e as Error;
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/system/fs/read", async (req, res) => {
  try {
    const filePath = path.resolve(expandPath(String(req.query.path || "")));
    if (!filePath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const stats = await fs.promises.stat(filePath);
    if (stats.isDirectory()) {
      res.status(400).json({ error: "path is a directory" });
      return;
    }

    // Limit file size to 1MB for safety
    const maxSize = 1024 * 1024;
    if (stats.size > maxSize) {
      res.status(400).json({ error: "file too large (max 1MB)" });
      return;
    }

    // Check if file is likely binary
    const ext = path.extname(filePath).toLowerCase();
    const binaryExtensions = [".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip", ".tar", ".gz", ".exe", ".bin", ".dll", ".so", ".dylib"];
    if (binaryExtensions.includes(ext)) {
      res.status(400).json({ error: "binary file not supported" });
      return;
    }

    const content = await fs.promises.readFile(filePath, "utf-8");
    res.json({
      path: filePath,
      content,
      size: stats.size,
    });
  } catch (e: unknown) {
    const err = e as Error;
    res.status(500).json({ error: err.message });
  }
});

// --- Approval Queue API ---

const safeStringify = (value: unknown): string => {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    if (typeof val === "bigint") return val.toString();
    return val;
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const isResolvableApprovalStatus = (value: unknown): value is ApprovalStatus => (
  value === "approved" || value === "denied" || value === "modified"
);

const respondApprovalError = (res: Response, context: string, err: unknown): void => {
  const error = err instanceof Error ? err : new Error("Unknown approvals error");
  log.error("Approvals API error", { context, error: error.message });
  res.status(500).json({ error: error.message });
};

app.get("/api/approvals", (_req, res) => {
  try {
    const pending = approvalQueue.getPending();
    res.setHeader("Content-Type", "application/json");
    res.send(safeStringify({ approvals: pending }));
  } catch (err) {
    respondApprovalError(res, "get pending", err);
  }
});

app.get("/api/approvals/all", (_req, res) => {
  try {
    const all = approvalQueue.getAll();
    res.setHeader("Content-Type", "application/json");
    res.send(safeStringify({ approvals: all }));
  } catch (err) {
    respondApprovalError(res, "get all", err);
  }
});

app.get("/api/approvals/:approvalId", (req, res) => {
  try {
    const approval = approvalQueue.get(req.params.approvalId);
    if (!approval) {
      res.status(404).json({ error: "approval not found" });
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.send(safeStringify({ approval }));
  } catch (err) {
    respondApprovalError(res, "get by id", err);
  }
});

app.post("/api/approvals/:approvalId/approve", (req, res) => {
  try {
    const feedback = req.body?.feedback ? String(req.body.feedback) : undefined;
    const ok = approvalQueue.approve(req.params.approvalId, feedback);
    if (!ok) {
      res.status(404).json({ error: "approval not found or already resolved" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    respondApprovalError(res, "approve", err);
  }
});

app.post("/api/approvals/:approvalId/deny", (req, res) => {
  try {
    const feedback = req.body?.feedback ? String(req.body.feedback) : undefined;
    const ok = approvalQueue.deny(req.params.approvalId, feedback);
    if (!ok) {
      res.status(404).json({ error: "approval not found or already resolved" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    respondApprovalError(res, "deny", err);
  }
});

app.post("/api/approvals/:approvalId/modify", (req, res) => {
  try {
    const modifiedArgs = isRecord(req.body?.modifiedArgs) ? req.body.modifiedArgs : undefined;
    const feedback = req.body?.feedback ? String(req.body.feedback) : undefined;

    if (!modifiedArgs) {
      res.status(400).json({ error: "modifiedArgs is required" });
      return;
    }

    const ok = approvalQueue.modify(req.params.approvalId, modifiedArgs, feedback);
    if (!ok) {
      res.status(404).json({ error: "approval not found or already resolved" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    respondApprovalError(res, "modify", err);
  }
});

app.post("/api/approvals/:approvalId/resolve", (req, res) => {
  try {
    const status = req.body?.status;
    const feedback = req.body?.feedback ? String(req.body.feedback) : undefined;
    const modifiedArgs = isRecord(req.body?.modifiedArgs) ? req.body.modifiedArgs : undefined;

    if (!isResolvableApprovalStatus(status)) {
      res.status(400).json({ error: "valid status is required (approved, denied, modified)" });
      return;
    }

    const ok = approvalQueue.resolve(req.params.approvalId, {
      status,
      feedback,
      modifiedArgs,
    });

    if (!ok) {
      res.status(404).json({ error: "approval not found or already resolved" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    respondApprovalError(res, "resolve", err);
  }
});

// --- Session Registry API ---

app.get("/api/sessions", (_req, res) => {
  // Return all sessions (useful for debugging)
  const runId = _req.query.runId as string | undefined;
  if (runId) {
    res.json({ sessions: sessionRegistry.getByRunId(runId) });
  } else {
    // No easy way to get all without run ID, so return empty for now
    res.json({ sessions: [] });
  }
});

app.get("/api/sessions/:nodeId", (req, res) => {
  const session = sessionRegistry.getByNodeId(req.params.nodeId);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  res.json({ session });
});

// --- Chat API ---

// Send a chat message to a run (optionally to a specific node)
app.post("/api/runs/:runId/chat", (req, res) => {
  const { runId } = req.params;
  const content = String(req.body?.content ?? "").trim();
  const nodeId = req.body?.nodeId ? String(req.body.nodeId) : undefined;
  const interrupt = req.body?.interrupt !== false; // Default to true

  if (!content) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  if (interrupt) {
    // Interrupt current execution and inject message
    const ok = orchestrator.interruptWithMessage(runId, content, nodeId);
    if (!ok) {
      // Run might not be active, queue instead and restart
      chatManager.queueMessage(runId, content, nodeId);

      // If run isn't active, we need to restart it to process the message
      if (!orchestrator.isRunning(runId)) {
        // Requeue the target node (or root) so it can process the message
        const targetNodeId = nodeId ?? run.rootOrchestratorNodeId;
        if (targetNodeId && run.nodes[targetNodeId]) {
          // Only requeue if node is in a terminal state
          const node = run.nodes[targetNodeId];
          if (node.status === "completed" || node.status === "failed" || node.status === "skipped") {
            store.updateNode(runId, targetNodeId, { status: "queued" });
            bus.emitNodePatch(runId, targetNodeId, { status: "queued" }, "node.progress");
          }
        }
        // Restart the scheduler loop
        void orchestrator.startRun(runId);
      }
    }
  } else {
    // Queue for next iteration
    chatManager.queueMessage(runId, content, nodeId);

    // If run isn't active, restart it
    if (!orchestrator.isRunning(runId)) {
      const targetNodeId = nodeId ?? run.rootOrchestratorNodeId;
      if (targetNodeId && run.nodes[targetNodeId]) {
        const node = run.nodes[targetNodeId];
        if (node.status === "completed" || node.status === "failed" || node.status === "skipped") {
          store.updateNode(runId, targetNodeId, { status: "queued" });
          bus.emitNodePatch(runId, targetNodeId, { status: "queued" }, "node.progress");
        }
      }
      void orchestrator.startRun(runId);
    }
  }

  res.json({ ok: true });
});

// Send a chat message to a specific node
app.post("/api/runs/:runId/nodes/:nodeId/chat", (req, res) => {
  const { runId, nodeId } = req.params;
  const content = String(req.body?.content ?? "").trim();
  const interrupt = req.body?.interrupt !== false;

  if (!content) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  if (interrupt) {
    const ok = orchestrator.interruptWithMessage(runId, content, nodeId);
    if (!ok) {
      chatManager.queueMessage(runId, content, nodeId);

      // If run isn't active, restart it
      if (!orchestrator.isRunning(runId)) {
        const node = run.nodes[nodeId];
        if (node && (node.status === "completed" || node.status === "failed" || node.status === "skipped")) {
          store.updateNode(runId, nodeId, { status: "queued" });
          bus.emitNodePatch(runId, nodeId, { status: "queued" }, "node.progress");
        }
        void orchestrator.startRun(runId);
      }
    }
  } else {
    chatManager.queueMessage(runId, content, nodeId);

    // If run isn't active, restart it
    if (!orchestrator.isRunning(runId)) {
      const node = run.nodes[nodeId];
      if (node && (node.status === "completed" || node.status === "failed" || node.status === "skipped")) {
        store.updateNode(runId, nodeId, { status: "queued" });
        bus.emitNodePatch(runId, nodeId, { status: "queued" }, "node.progress");
      }
      void orchestrator.startRun(runId);
    }
  }

  res.json({ ok: true });
});

// Get chat messages for a run
app.get("/api/runs/:runId/chat", (req, res) => {
  const { runId } = req.params;
  const nodeId = req.query.nodeId ? String(req.query.nodeId) : undefined;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const messages = chatManager.getMessages(runId, nodeId);
  res.json({ messages });
});

// Set interaction mode for a run
app.post("/api/runs/:runId/mode", (req, res) => {
  const { runId } = req.params;
  const mode = req.body?.mode as InteractionMode;
  const nodeId = req.body?.nodeId ? String(req.body.nodeId) : undefined;

  if (!mode || !["autonomous", "interactive"].includes(mode)) {
    res.status(400).json({ error: "valid mode is required (autonomous, interactive)" });
    return;
  }

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  orchestrator.setInteractionMode(runId, mode, nodeId);
  res.json({ ok: true, mode });
});

app.get("/api/runs/:runId/mode", (req, res) => {
  const { runId } = req.params;
  const nodeId = req.query.nodeId ? String(req.query.nodeId) : undefined;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const mode = orchestrator.getInteractionMode(runId, nodeId);
  res.json({ mode });
});

// Set global mode for a run (PLANNING vs IMPLEMENTATION)
app.post("/api/runs/:runId/global_mode", (req, res) => {
  const { runId } = req.params;
  const mode = req.body?.mode as GlobalMode;

  if (!mode || !["PLANNING", "IMPLEMENTATION"].includes(mode)) {
    res.status(400).json({ error: "valid global mode is required (PLANNING, IMPLEMENTATION)" });
    return;
  }

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  orchestrator.setGlobalMode(runId, mode);
  res.json({ ok: true, mode });
});

// Set CLI permissions policy for a run
app.post("/api/runs/:runId/policy/skip_cli_permissions", (req, res) => {
  const { runId } = req.params;
  const skip = req.body?.skip;

  if (typeof skip !== "boolean") {
    res.status(400).json({ error: "skip must be a boolean" });
    return;
  }

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  // Update the run's policy
  run.policy = {
    ...run.policy,
    skipCliPermissions: skip,
  };
  store.persistRun(run);

  res.json({ ok: true, skipCliPermissions: skip });
});

// Initialize git repo for a run
app.post("/api/runs/:runId/git/init", (req, res) => {
  const { runId } = req.params;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  // Use workspace manager to init
  const result = workspace.initializeGitRepo(run.repoPath);
  if (!result.ok) {
    res.status(500).json({ error: result.error });
    return;
  }

  // Force re-detection of repo facts to update state
  // We can't easily call private method on orchestrator, so we manually update store for now
  // OR we can add a public method to orchestrator to refresh facts.
  // Actually, orchestrator exposes startRun but not refresh.
  // For v0, let's just update the local run object if we can, or rely on orchestrator to pick it up on next boot.
  // Better: We should probably trigger a re-scan.
  // But since we don't have a public re-scan, let's just manually update the facts in store if possible?
  // No, `detectRepoFacts` is private.
  // Let's assume the UI will verify by another means or we accept that it might take a restart/reload to see "isGitRepo: true" in facts?
  // Wait, if we don't update facts, the UI button won't disappear.
  // Let's manually flip the bit in the store for immediate feedback.
  if (run.repoFacts) {
    run.repoFacts.isGitRepo = true;
    store.persistRun(run);
    bus.emitRunPatch(runId, { id: runId, repoFacts: run.repoFacts }, "run.updated");
  }

  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT QUEUE API (Section 3.4)
// ═══════════════════════════════════════════════════════════════════════════

// Get pending prompts for a run
app.get("/api/runs/:runId/prompts", (req, res) => {
  const { runId } = req.params;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const prompts = promptQueue.getPendingForRun(runId);
  const orchestratorPending = promptQueue.getOrchestratorPending(runId);
  const userPending = promptQueue.getUserPending(runId);

  res.json({
    prompts,
    orchestratorPending,
    userPending,
    hasOrchestratorPending: orchestratorPending.length > 0,
  });
});

// Get a specific prompt
app.get("/api/runs/:runId/prompts/:promptId", (req, res) => {
  const { promptId } = req.params;

  const prompt = promptQueue.getPrompt(promptId);
  if (!prompt) {
    res.status(404).json({ error: "prompt not found" });
    return;
  }

  res.json({ prompt });
});

// Get run events (history)
app.get("/api/runs/:runId/events", (req, res) => {
  const { runId } = req.params;
  const eventsPath = store.eventsFilePath(runId);

  if (!fs.existsSync(eventsPath)) {
    res.json({ events: [] });
    return;
  }

  try {
    const content = fs.readFileSync(eventsPath, "utf-8");
    const events = content
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    res.json({ events });
  } catch (e: unknown) {
    const err = e as Error;
    res.status(500).json({ error: err.message });
  }
});

// --- Start the server ---
// --- Start the server ---
const server = http.createServer(app);

// Initialize WebSocket server
new WebSocketServer({ server }).on("connection", (ws: WebSocket) => {
  const state: WsClientState = { runIds: new Set() };

  // Subscribe to bus events
  const onRunPatch = (runId: string, patch: any, event: string) => {
    // Broadcast generic run updates to everyone, or filter?
    // For now everyone sees run list updates
    ws.send(JSON.stringify({ type: "run.patch", runId, patch, event }));
  };

  const onNodePatch = (runId: string, nodeId: string, patch: any, event: string) => {
    if (state.runIds.has(runId)) {
      ws.send(JSON.stringify({ type: "node.patch", runId, nodeId, patch, event }));
    }
  };

  const onNodeProgress = (runId: string, nodeId: string, message: string, raw?: any) => {
    if (state.runIds.has(runId)) {
      ws.send(JSON.stringify({ type: "node.progress", runId, nodeId, message, raw }));
    }
  };

  const onEdge = (runId: string, edge: any) => {
    if (state.runIds.has(runId)) {
      ws.send(JSON.stringify({ type: "edge.created", runId, edge }));
    }
  };

  const onHandoff = (runId: string, from: string, to: string, edgeId: string, payload: any) => {
    if (state.runIds.has(runId)) {
      ws.send(JSON.stringify({ type: "handoff", runId, from, to, edgeId, payload }));
    }
  };

  const onArtifact = (runId: string, artifact: any) => {
    if (state.runIds.has(runId)) {
      ws.send(JSON.stringify({ type: "artifact.created", runId, artifact }));
    }
  };

  const onRunPhaseChanged = (runId: string, phase: string, prev: string, reason?: string) => {
    ws.send(JSON.stringify({ type: "run.phase", runId, phase, prev, reason }));
  }

  // New Global Mode Event
  const onRunModeChanged = (runId: string, mode: string, prev: string, reason?: string) => {
    // This is for RunMode (AUTO/INTERACTIVE), wait, emitRunModeChanged is currently used for RunMode
    // but typically UI listens to "run.patch" for generic property updates which I implemented in setGlobalMode
    // So this is redundant but harmless.
    ws.send(JSON.stringify({ type: "run.mode", runId, mode, prev, reason }));
  }

  const onNodeControlChanged = (runId: string, nodeId: string, control: any) => {
    if (state.runIds.has(runId)) {
      ws.send(JSON.stringify({ type: "node.control", runId, nodeId, control }));
    }
  }

  const unsubscribeBus = bus.subscribe((event) => {
    switch (event.type) {
      case "run.created":
      case "run.started":
      case "run.updated":
      case "run.completed":
      case "run.failed":
      case "run.stopped":
      case "run.paused":
      case "run.resumed":
        // @ts-ignore
        onRunPatch(event.runId, event.run, event.type);
        break;

      case "node.created":
      case "node.started":
      case "node.completed":
      case "node.failed":
        // @ts-ignore
        onNodePatch(event.runId, event.nodeId, event.patch, event.type);
        break;

      case "node.progress":
        // @ts-ignore
        onNodeProgress(event.runId, event.nodeId, event.message, event.raw);
        break;

      case "message.user":
      case "message.assistant.delta":
      case "message.assistant.final":
      case "message.reasoning":
      case "tool.proposed":
      case "tool.started":
      case "tool.completed":
      case "console.chunk":
        // Forward these events directly with their original type
        // @ts-ignore
        if (state.runIds.has(event.runId)) {
          ws.send(JSON.stringify(event));
        }
        break;

      case "edge.created":
        // @ts-ignore
        onEdge(event.runId, event.edge);
        break;

      case "handoff.sent":
        // @ts-ignore
        onHandoff(event.runId, event.fromNodeId, event.toNodeId, event.edgeId, event.payload);
        break;

      case "artifact.created":
        // @ts-ignore
        onArtifact(event.runId, event.artifact);
        break;

      case "run.phase.changed":
        // @ts-ignore
        onRunPhaseChanged(event.runId, event.phase, event.previousPhase, event.reason);
        break;

      case "run.mode.changed":
        // @ts-ignore
        onRunModeChanged(event.runId, event.mode, event.previousMode, event.reason);
        break;

      case "node.control.changed":
        // @ts-ignore
        onNodeControlChanged(event.runId, event.nodeId, event.control);
        break;

      case "chat.message.sent":
      case "chat.message.queued":
      case "interaction.mode.changed":
      case "prompt.queued":
      case "prompt.sent":
      case "prompt.cancelled":
      case "approval.requested":
      case "approval.resolved":
        // @ts-ignore
        if (state.runIds.has(event.runId)) {
          ws.send(JSON.stringify(event));
        }
        break;
    }
  });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(String(msg));
      if (data.type === "subscribe") {
        if (data.runId) {
          state.runIds.add(data.runId);
          log.debug("WS client subscribed to run", { runId: data.runId });
        }
      }
      if (data.type === "unsubscribe") {
        if (data.runId) {
          state.runIds.delete(data.runId);
          log.debug("WS client unsubscribed from run", { runId: data.runId });
        }
      }
    } catch (e) {
      log.warn("WS message parse error", { error: e instanceof Error ? e.message : String(e) });
    }
  });

  ws.on("close", () => {
    unsubscribeBus();
  });
});

// --- Startup Cleanup ---
async function cleanupZombieState() {
  log.info("Running startup cleanup");
  const runs = store.listRunsFiltered(false);
  let recoveredCount = 0;

  for (const run of runs) {
    if (run.status === "completed" || run.status === "failed") continue;

    let hasChanges = false;
    for (const node of Object.values(run.nodes)) {
      if (node.status === "running") {
        log.warn("Recovering zombie node", { runId: run.id, nodeId: node.id, label: node.label });
        node.status = "queued";
        hasChanges = true;
        recoveredCount++;
      }
    }

    if (hasChanges) {
      store.persistRun(run);
    }

    // Resume scheduler for this run if it's active (running/queued)
    if (run.status === "running" || run.status === "queued" || run.status === "paused") {
      log.info("Resuming scheduler for run", { runId: run.id, phase: run.phase });
      orchestrator.recoverRun(run.id).catch(e => {
        log.error("Failed to recover run", { runId: run.id, error: e instanceof Error ? e.message : String(e) });
      });
    }
  }
  log.info("Startup cleanup complete", { recoveredZombieNodes: recoveredCount });
}

cleanupZombieState();

const port = cfg.server?.port ?? 4317;

server.on("error", (e: any) => {
  if (e.code === "EADDRINUSE") {
    log.error("Port is already in use", { port, error: "EADDRINUSE" });
    console.error(`\nError: Port ${port} is already in use.`);
    console.error("Please stop the existing process or change the port in vuhlp.config.json\n");
    process.exit(1);
  } else {
    log.error("Server error", { error: e });
    throw e;
  }
});

server.listen(port, () => {
  log.info("Daemon started", { port, dataDir: store.getDataDir() });
});
