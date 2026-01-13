import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

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
import { ApprovalStatus, InteractionMode, RunMode, NodeControl, RoleId } from "./core/types.js";

type WsClientState = {
  runIds: Set<string>;
};

let cfg = loadConfig();
const store = new RunStore({ dataDir: cfg.dataDir! });
const bus = new EventBus(store);
const providers = new ProviderRegistry(cfg.providers!);
const workspace = new WorkspaceManager({
  mode: cfg.workspace!.mode ?? "shared",
  rootDir: cfg.workspace!.rootDir ?? ".vuhlp/workspaces",
});
const chatManager = new ChatManager(bus);
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
  const mode = (req.body?.mode as RunMode) ?? "AUTO";
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

  const run = store.createRun({
    prompt,
    repoPath,
    maxIterations: cfg.orchestration!.maxIterations ?? 3,
    config: cfg as Record<string, unknown>,
    mode,
    policy,
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

app.get("/api/system/fs", async (req, res) => {
  try {
    const currentPath = path.resolve(String(req.query.path || process.cwd()));
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
    const filePath = path.resolve(String(req.query.path || ""));
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

app.get("/api/approvals", (_req, res) => {
  const pending = approvalQueue.getPending();
  res.json({ approvals: pending });
});

app.get("/api/approvals/all", (_req, res) => {
  const all = approvalQueue.getAll();
  res.json({ approvals: all });
});

app.get("/api/approvals/:approvalId", (req, res) => {
  const approval = approvalQueue.get(req.params.approvalId);
  if (!approval) {
    res.status(404).json({ error: "approval not found" });
    return;
  }
  res.json({ approval });
});

app.post("/api/approvals/:approvalId/approve", (req, res) => {
  const feedback = req.body?.feedback ? String(req.body.feedback) : undefined;
  const ok = approvalQueue.approve(req.params.approvalId, feedback);
  if (!ok) {
    res.status(404).json({ error: "approval not found or already resolved" });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/approvals/:approvalId/deny", (req, res) => {
  const feedback = req.body?.feedback ? String(req.body.feedback) : undefined;
  const ok = approvalQueue.deny(req.params.approvalId, feedback);
  if (!ok) {
    res.status(404).json({ error: "approval not found or already resolved" });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/approvals/:approvalId/modify", (req, res) => {
  const modifiedArgs = req.body?.modifiedArgs as Record<string, unknown> | undefined;
  const feedback = req.body?.feedback ? String(req.body.feedback) : undefined;

  if (!modifiedArgs || typeof modifiedArgs !== "object") {
    res.status(400).json({ error: "modifiedArgs is required" });
    return;
  }

  const ok = approvalQueue.modify(req.params.approvalId, modifiedArgs, feedback);
  if (!ok) {
    res.status(404).json({ error: "approval not found or already resolved" });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/approvals/:approvalId/resolve", (req, res) => {
  const status = req.body?.status as ApprovalStatus;
  const feedback = req.body?.feedback ? String(req.body.feedback) : undefined;
  const modifiedArgs = req.body?.modifiedArgs as Record<string, unknown> | undefined;

  if (!status || !["approved", "denied", "modified"].includes(status)) {
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
      // Run might not be active, queue instead
      chatManager.queueMessage(runId, content, nodeId);
    }
  } else {
    // Queue for next iteration
    chatManager.queueMessage(runId, content, nodeId);
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
    }
  } else {
    chatManager.queueMessage(runId, content, nodeId);
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

// Get interaction mode for a run
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

// Add a user prompt to the queue
app.post("/api/runs/:runId/prompts", (req, res) => {
  const { runId } = req.params;
  const content = String(req.body?.content ?? "").trim();
  const targetNodeId = req.body?.targetNodeId ? String(req.body.targetNodeId) : undefined;

  if (!content) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const prompt = promptQueue.addUserPrompt({
    runId,
    targetNodeId,
    content,
  });

  res.json({ prompt });
});

// Send a pending prompt
app.post("/api/runs/:runId/prompts/:promptId/send", async (req, res) => {
  const { runId, promptId } = req.params;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const prompt = promptQueue.getPrompt(promptId);
  if (!prompt || prompt.runId !== runId) {
    res.status(404).json({ error: "prompt not found" });
    return;
  }

  if (prompt.status !== "pending") {
    res.status(400).json({ error: "prompt is not pending" });
    return;
  }

  // Mark as sent
  const ok = promptQueue.markSent(promptId);
  if (!ok) {
    res.status(400).json({ error: "failed to mark prompt as sent" });
    return;
  }

  // Actually send the prompt to the target node
  if (prompt.targetNodeId) {
    try {
      const result = await orchestrator.manualTurn(runId, prompt.targetNodeId, prompt.content);
      res.json({ ok: true, result });
    } catch (e: unknown) {
      const err = e as Error;
      res.status(500).json({ ok: false, error: err.message });
    }
  } else {
    // Queue as a chat message if no target node
    chatManager.queueMessage(runId, prompt.content);
    res.json({ ok: true, queued: true });
  }
});

// Cancel a pending prompt
app.post("/api/runs/:runId/prompts/:promptId/cancel", (req, res) => {
  const { runId, promptId } = req.params;
  const reason = req.body?.reason ? String(req.body.reason) : undefined;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const prompt = promptQueue.getPrompt(promptId);
  if (!prompt || prompt.runId !== runId) {
    res.status(404).json({ error: "prompt not found" });
    return;
  }

  const ok = promptQueue.cancel(promptId, reason);
  if (!ok) {
    res.status(400).json({ error: "prompt not pending or already cancelled" });
    return;
  }

  res.json({ ok: true });
});

// Modify a pending prompt's content
app.patch("/api/runs/:runId/prompts/:promptId", (req, res) => {
  const { runId, promptId } = req.params;
  const content = req.body?.content ? String(req.body.content) : undefined;

  if (!content) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const prompt = promptQueue.getPrompt(promptId);
  if (!prompt || prompt.runId !== runId) {
    res.status(404).json({ error: "prompt not found" });
    return;
  }

  const ok = promptQueue.modifyContent(promptId, content);
  if (!ok) {
    res.status(400).json({ error: "prompt not pending or modification failed" });
    return;
  }

  res.json({ ok: true, prompt: promptQueue.getPrompt(promptId) });
});

// ═══════════════════════════════════════════════════════════════════════════
// RUN MODE CONTROL API (AUTO/INTERACTIVE orchestration)
// ═══════════════════════════════════════════════════════════════════════════

// Set run mode (AUTO or INTERACTIVE)
app.post("/api/runs/:runId/run-mode", (req, res) => {
  const { runId } = req.params;
  const mode = req.body?.mode as RunMode;

  if (!mode || !["AUTO", "INTERACTIVE"].includes(mode)) {
    res.status(400).json({ error: "valid mode is required (AUTO, INTERACTIVE)" });
    return;
  }

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const ok = orchestrator.setRunMode(runId, mode);
  res.json({ ok, mode });
});

// Get run mode
app.get("/api/runs/:runId/run-mode", (req, res) => {
  const { runId } = req.params;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const mode = orchestrator.getRunMode(runId);
  res.json({ mode });
});

// ═══════════════════════════════════════════════════════════════════════════
// NODE CONTROL API
// ═══════════════════════════════════════════════════════════════════════════

// Set node control (AUTO or MANUAL)
app.post("/api/runs/:runId/nodes/:nodeId/control", (req, res) => {
  const { runId, nodeId } = req.params;
  const control = req.body?.control as NodeControl;

  if (!control || !["AUTO", "MANUAL"].includes(control)) {
    res.status(400).json({ error: "valid control is required (AUTO, MANUAL)" });
    return;
  }

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  if (!run.nodes[nodeId]) {
    res.status(404).json({ error: "node not found" });
    return;
  }

  const ok = orchestrator.setNodeControl(runId, nodeId, control);
  res.json({ ok, control });
});

// Get node control
app.get("/api/runs/:runId/nodes/:nodeId/control", (req, res) => {
  const { runId, nodeId } = req.params;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  if (!run.nodes[nodeId]) {
    res.status(404).json({ error: "node not found" });
    return;
  }

  const control = orchestrator.getNodeControl(runId, nodeId);
  res.json({ control });
});

// ═══════════════════════════════════════════════════════════════════════════
// MANUAL TURN CONTROL API
// ═══════════════════════════════════════════════════════════════════════════

// Send a manual turn to a node
app.post("/api/runs/:runId/nodes/:nodeId/turn", async (req, res) => {
  const { runId, nodeId } = req.params;
  const message = String(req.body?.message ?? "").trim();
  const options = req.body?.options as {
    attachContext?: string[];
    expectedSchema?: string;
  } | undefined;

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  if (!run.nodes[nodeId]) {
    res.status(404).json({ error: "node not found" });
    return;
  }

  try {
    const result = await orchestrator.manualTurn(runId, nodeId, message, options);
    res.json(result);
  } catch (e: unknown) {
    const err = e as Error;
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send a "continue" instruction to a node
app.post("/api/runs/:runId/nodes/:nodeId/continue", async (req, res) => {
  const { runId, nodeId } = req.params;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  if (!run.nodes[nodeId]) {
    res.status(404).json({ error: "node not found" });
    return;
  }

  try {
    const result = await orchestrator.manualContinue(runId, nodeId);
    res.json(result);
  } catch (e: unknown) {
    const err = e as Error;
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cancel a node
app.post("/api/runs/:runId/nodes/:nodeId/cancel", (req, res) => {
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

  // Mark node as skipped/cancelled
  node.status = "skipped";
  node.completedAt = nowIso();
  store.persistRun(run);

  bus.emitNodePatch(runId, nodeId, {
    status: "skipped",
    completedAt: node.completedAt,
  }, "node.completed");

  res.json({ ok: true });
});

// Manually run verification
app.post("/api/runs/:runId/verify", async (req, res) => {
  const { runId } = req.params;
  const profileId = req.body?.profileId ? String(req.body.profileId) : undefined;

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  try {
    const result = await orchestrator.manualVerify(runId, profileId);
    res.json(result);
  } catch (e: unknown) {
    const err = e as Error;
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create a new node manually
app.post("/api/runs/:runId/nodes", (req, res) => {
  const { runId } = req.params;
  const parentNodeId = req.body?.parentNodeId ? String(req.body.parentNodeId) : undefined;
  const providerId = req.body?.providerId ? String(req.body.providerId) : undefined;
  const role = req.body?.role as RoleId | undefined;
  const label = req.body?.label ? String(req.body.label) : undefined;
  const control = req.body?.control as NodeControl | undefined;

  if (!providerId) {
    res.status(400).json({ error: "providerId is required" });
    return;
  }

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const actualParentNodeId = parentNodeId ?? run.rootOrchestratorNodeId;

  const node = orchestrator.createManualNode({
    runId,
    parentNodeId: actualParentNodeId,
    providerId,
    role,
    label,
    control,
  });

  if (!node) {
    res.status(500).json({ error: "failed to create node" });
    return;
  }

  res.json({ node });
});

// Create a new edge manually
app.post("/api/runs/:runId/edges", (req, res) => {
  const { runId } = req.params;
  const sourceId = req.body?.sourceId ? String(req.body.sourceId) : undefined;
  const targetId = req.body?.targetId ? String(req.body.targetId) : undefined;
  const type = (req.body?.type ?? "handoff") as "handoff" | "dependency" | "report" | "gate";
  const label = req.body?.label ? String(req.body.label) : undefined;

  if (!sourceId || !targetId) {
    res.status(400).json({ error: "sourceId and targetId are required" });
    return;
  }

  const run = store.getRun(runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  if (!run.nodes[sourceId]) {
    res.status(404).json({ error: "source node not found" });
    return;
  }

  if (!run.nodes[targetId]) {
    res.status(404).json({ error: "target node not found" });
    return;
  }

  orchestrator.createEdge(runId, sourceId, targetId, type, label);
  res.json({ ok: true });
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
