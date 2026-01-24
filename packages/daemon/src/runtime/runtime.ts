import { promises as fs } from "fs";
import path from "path";
import type {
  ApprovalRequest,
  ApprovalResolution,
  Artifact,
  ArtifactKind,
  ArtifactMetadata,
  CreateTemplateResponse,
  DeleteTemplateResponse,
  EdgeManagementScope,
  EdgeState,
  Envelope,
  EventEnvelope,
  FileEntry,
  GlobalMode,
  GetRoleTemplateResponse,
  ListDirectoryResponse,
  ListTemplatesResponse,
  NodeConnection,
  NodeConfig,
  NodeConfigInput,
  NodeState,
  OrchestrationMode,
  RunState,
  TemplateInfo,
  UpdateTemplateResponse,
  UsageTotals,
  UserMessageRecord,
  UUID
} from "@vuhlp/contracts";
import { EventBus } from "./event-bus.js";
import { ArtifactStore } from "./artifact-store.js";
import { EventLog } from "./event-log.js";
import { RunStore, type NodeRecord, type RunRecord } from "./store.js";
import { Scheduler } from "./scheduler.js";
import { type NodeRunner } from "./runner.js";
import { CliRunner } from "./cli-runner.js";
import { newId, nowIso } from "./utils.js";
import {
  ConsoleLogger,
  CreateEdgeRequest,
  CreateEdgeResult,
  type Logger,
  SendHandoffRequest,
  SendHandoffResult,
  SpawnNodeRequest,
  SpawnNodeResult
} from "@vuhlp/providers";

const addUsage = (current: UsageTotals | undefined, delta: UsageTotals): UsageTotals => ({
  promptTokens: (current?.promptTokens ?? 0) + delta.promptTokens,
  completionTokens: (current?.completionTokens ?? 0) + delta.completionTokens,
  totalTokens: (current?.totalTokens ?? 0) + delta.totalTokens
});

const getErrorCode = (error: { code?: string } | null | undefined): string | undefined => error?.code;

export interface RuntimeOptions {
  dataDir: string;
  runner?: NodeRunner;
  stallThreshold?: number;
  repoRoot?: string;
  appRoot?: string;
  systemTemplatesDir?: string;
  logger?: Logger;
}

export class Runtime {
  private readonly store: RunStore;
  private readonly eventBus: EventBus;
  private readonly scheduler: Scheduler;
  private readonly runner: NodeRunner;
  private readonly dataDir: string;
  private readonly repoRoot: string;
  private readonly appRoot: string;
  private readonly systemTemplatesDir?: string;
  private readonly logger: Logger;
  private readonly artifactStores = new Map<UUID, ArtifactStore>();
  private readonly snapshotTimers = new Map<UUID, NodeJS.Timeout>();

  constructor(options: RuntimeOptions) {
    this.dataDir = options.dataDir;
    this.repoRoot = path.resolve(options.repoRoot ?? process.cwd());
    this.appRoot = path.resolve(options.appRoot ?? this.repoRoot);
    this.systemTemplatesDir = options.systemTemplatesDir;
    this.logger = options.logger ?? new ConsoleLogger({ scope: "runtime" });
    this.store = new RunStore(this.dataDir, this.logger);
    this.eventBus = new EventBus();
    this.runner =
      options.runner ??
      new CliRunner({
        repoRoot: this.repoRoot,
        appRoot: this.appRoot,
        emitEvent: this.emitEvent.bind(this),
        spawnNode: this.spawnNodeFromTool.bind(this),
        createEdge: this.createEdgeFromTool.bind(this),
        sendHandoff: this.sendHandoffFromTool.bind(this),
        systemTemplatesDir: this.systemTemplatesDir,
        logger: this.logger
      });
    this.scheduler = new Scheduler({
      store: this.store,
      emitEvent: this.emitEvent.bind(this),
      runner: this.runner,
      dataDir: this.dataDir,
      stallThreshold: options.stallThreshold,
      logger: this.logger
    });
  }

  async start(): Promise<void> {
    await this.loadPersistedRuns();
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  async shutdown(reason = "shutdown"): Promise<void> {
    this.logger.info("runtime shutdown started", { reason });
    this.scheduler.stop();
    const now = nowIso();
    for (const record of this.store.listRunRecords()) {
      for (const nodeRecord of record.nodes.values()) {
        if (this.runner.disposeNode) {
          try {
            await this.runner.disposeNode(nodeRecord.state.id);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error("failed to dispose node during shutdown", {
              runId: record.state.id,
              nodeId: nodeRecord.state.id,
              message
            });
          }
        }
        const disconnected: NodeConnection = {
          status: "disconnected",
          streaming: false,
          lastHeartbeatAt: now,
          lastOutputAt: now
        };
        const nextStatus = nodeRecord.state.status === "running" ? "idle" : nodeRecord.state.status;
        nodeRecord.state = {
          ...nodeRecord.state,
          status: nextStatus,
          summary: nodeRecord.state.status === "running" ? "idle" : nodeRecord.state.summary,
          connection: nodeRecord.state.connection
            ? { ...nodeRecord.state.connection, ...disconnected }
            : disconnected,
          lastActivityAt: now,
          inboxCount: 0
        };
        record.state.nodes[nodeRecord.state.id] = nodeRecord.state;
      }
      if (record.state.status === "running") {
        record.state.status = "paused";
      }
      record.state.updatedAt = now;
      await this.saveRunSnapshot(record.state.id);
    }
    // Flush any pending snapshots before shutting down
    for (const runId of this.snapshotTimers.keys()) {
      await this.flushRunSnapshot(runId);
    }

    this.logger.info("runtime shutdown complete", { runs: this.store.listRuns().length });
  }

  onEvent(listener: (event: EventEnvelope) => void): () => void {
    return this.eventBus.on(listener);
  }

  listRuns(): RunState[] {
    return this.store.listRuns();
  }

  getRun(runId: UUID): RunState {
    const record = this.requireRun(runId);
    return record.state;
  }

  async getRoleTemplate(templateName: string): Promise<GetRoleTemplateResponse> {
    const name = templateName.trim();
    if (!name) {
      throw new Error("template name is required");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error("invalid template name");
    }
    const templatePath = path.resolve(this.repoRoot, "docs", "templates", `${name}.md`);
    try {
      const content = await fs.readFile(templatePath, "utf8");
      return { name, content, found: true };
    } catch (error) {
      // fallback to system templates
      if (this.systemTemplatesDir) {
        const systemPath = path.resolve(this.systemTemplatesDir, `${name}.md`);
        try {
          const content = await fs.readFile(systemPath, "utf8");
          return { name, content, found: true };
        } catch (sysError) {
          // ignore
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("role template not found", { name, message, templatePath });
      return { name, content: `Role template not found: ${name}`, found: false };
    }
  }

  async listTemplates(): Promise<ListTemplatesResponse> {
    const templates: TemplateInfo[] = [];
    const seen = new Set<string>();

    // Repo templates (user overrides) - take priority
    const repoTemplatesDir = path.resolve(this.repoRoot, "docs", "templates");
    try {
      const entries = await fs.readdir(repoTemplatesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const name = entry.name.replace(/\.md$/, "");
          if (/^[a-zA-Z0-9_-]+$/.test(name)) {
            templates.push({
              name,
              source: "repo",
              path: path.join(repoTemplatesDir, entry.name)
            });
            seen.add(name);
          }
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("failed to list repo templates", { message });
      }
    }

    // System templates (defaults)
    if (this.systemTemplatesDir) {
      try {
        const entries = await fs.readdir(this.systemTemplatesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(".md")) {
            const name = entry.name.replace(/\.md$/, "");
            if (/^[a-zA-Z0-9_-]+$/.test(name) && !seen.has(name)) {
              templates.push({
                name,
                source: "system",
                path: path.join(this.systemTemplatesDir, entry.name)
              });
            }
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn("failed to list system templates", { message });
        }
      }
    }

    templates.sort((a, b) => a.name.localeCompare(b.name));
    return { templates };
  }

  async createTemplate(name: string, content: string): Promise<CreateTemplateResponse> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error("template name is required");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedName)) {
      throw new Error("invalid template name: only alphanumeric, underscore, and hyphen allowed");
    }

    const templatesDir = path.resolve(this.repoRoot, "docs", "templates");
    const templatePath = path.join(templatesDir, `${trimmedName}.md`);

    // Check if already exists
    try {
      await fs.access(templatePath);
      throw new Error(`template already exists: ${trimmedName}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    // Ensure directory exists and write file
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.writeFile(templatePath, content, "utf8");
    this.logger.info("template created", { name: trimmedName, path: templatePath });

    return { name: trimmedName, path: templatePath };
  }

  async updateTemplate(name: string, content: string): Promise<UpdateTemplateResponse> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error("template name is required");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedName)) {
      throw new Error("invalid template name");
    }

    const templatesDir = path.resolve(this.repoRoot, "docs", "templates");
    const templatePath = path.join(templatesDir, `${trimmedName}.md`);

    // Check if exists in repo (we only allow editing repo templates, not system)
    try {
      await fs.access(templatePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Check if it's a system template being overridden
        if (this.systemTemplatesDir) {
          const systemPath = path.join(this.systemTemplatesDir, `${trimmedName}.md`);
          try {
            await fs.access(systemPath);
            // System template exists, create repo override
            await fs.mkdir(templatesDir, { recursive: true });
            await fs.writeFile(templatePath, content, "utf8");
            this.logger.info("system template overridden", { name: trimmedName, path: templatePath });
            return { name: trimmedName, path: templatePath };
          } catch {
            // System template doesn't exist either
          }
        }
        throw new Error(`template not found: ${trimmedName}`);
      }
      throw error;
    }

    await fs.writeFile(templatePath, content, "utf8");
    this.logger.info("template updated", { name: trimmedName, path: templatePath });

    return { name: trimmedName, path: templatePath };
  }

  async deleteTemplate(name: string): Promise<DeleteTemplateResponse> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error("template name is required");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedName)) {
      throw new Error("invalid template name");
    }

    const templatesDir = path.resolve(this.repoRoot, "docs", "templates");
    const templatePath = path.join(templatesDir, `${trimmedName}.md`);

    // Only delete repo templates, not system templates
    try {
      await fs.access(templatePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(`template not found in repo: ${trimmedName}`);
      }
      throw error;
    }

    await fs.unlink(templatePath);
    this.logger.info("template deleted", { name: trimmedName, path: templatePath });

    return { name: trimmedName };
  }

  async getEvents(
    runId: UUID,
    options?: { limit?: number; before?: number }
  ): Promise<{ events: EventEnvelope[]; page: { nextCursor: string | null; hasMore: boolean } }> {
    const record = this.requireRun(runId);
    const limit = options?.limit ?? 200;
    const page = await record.eventLog.readPage({ limit, before: options?.before });
    return { events: page.events, page: { nextCursor: page.nextCursor, hasMore: page.hasMore } };
  }

  private runSnapshotPath(runId: UUID): string {
    return path.join(this.dataDir, "runs", runId, "state.json");
  }

  private async saveRunSnapshot(runId: UUID): Promise<void> {
    const record = this.store.getRun(runId);
    if (!record) {
      if (this.snapshotTimers.has(runId)) {
        clearTimeout(this.snapshotTimers.get(runId));
        this.snapshotTimers.delete(runId);
      }
      return;
    }

    if (this.snapshotTimers.has(runId)) {
      clearTimeout(this.snapshotTimers.get(runId));
    }

    const timer = setTimeout(async () => {
      this.snapshotTimers.delete(runId);
      await this.performSnapshotSave(runId);
    }, 2000); // Debounce for 2 seconds

    this.snapshotTimers.set(runId, timer);
  }

  private async flushRunSnapshot(runId: UUID): Promise<void> {
    if (this.snapshotTimers.has(runId)) {
      clearTimeout(this.snapshotTimers.get(runId));
      this.snapshotTimers.delete(runId);
      await this.performSnapshotSave(runId);
    }
  }

  private async performSnapshotSave(runId: UUID): Promise<void> {
    const record = this.store.getRun(runId);
    if (!record) {
      return;
    }
    const snapshotPath = this.runSnapshotPath(runId);
    try {
      await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
      await fs.writeFile(snapshotPath, JSON.stringify(record.state, null, 2), "utf8");
      this.logger.debug("run snapshot saved", { runId, path: snapshotPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to save run snapshot", { runId, message });
    }
  }

  private async loadPersistedRuns(): Promise<void> {
    const runsDir = path.join(this.dataDir, "runs");
    let entries: Array<import("fs").Dirent> = [];
    try {
      entries = await fs.readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      const code = getErrorCode(error as any);
      if (code === "ENOENT") {
        this.logger.info("no persisted runs found", { runsDir });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to read runs directory", { runsDir, message });
      return;
    }

    const runDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (runDirs.length === 0) {
      this.logger.info("no persisted runs found", { runsDir });
      return;
    }

    for (const runId of runDirs) {
      const snapshot = await this.readRunSnapshot(runId);
      const runState = snapshot ?? (await this.rebuildRunStateFromEvents(runId));
      if (!runState) {
        this.logger.warn("skipping persisted run (no snapshot or events)", { runId });
        continue;
      }
      const normalized = this.normalizePersistedRunState(runState);
      this.rehydrateRun(normalized);
      this.logger.info("rehydrated run", {
        runId: normalized.id,
        nodes: Object.keys(normalized.nodes).length,
        edges: Object.keys(normalized.edges).length
      });
    }
  }

  private async readRunSnapshot(runId: string): Promise<RunState | null> {
    const snapshotPath = this.runSnapshotPath(runId);
    try {
      const contents = await fs.readFile(snapshotPath, "utf8");
      const parsed: RunState = JSON.parse(contents);
      this.logger.info("loaded run snapshot", { runId, path: snapshotPath });
      return parsed;
    } catch (error) {
      const code = getErrorCode(error as any);
      if (code === "ENOENT") {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to read run snapshot", { runId, path: snapshotPath, message });
      return null;
    }
  }

  private async rebuildRunStateFromEvents(runId: string): Promise<RunState | null> {
    const eventLog = new EventLog(this.dataDir, runId, this.logger);
    let runState: RunState | null = null;
    let eventCount = 0;

    try {
      eventCount = await eventLog.replay((event) => {
        if (event.type === "run.patch") {
          if (!runState) {
            const base: RunState = {
              id: event.runId,
              contractVersion: "1",
              status: "paused",
              mode: "AUTO",
              globalMode: "IMPLEMENTATION",
              createdAt: event.ts,
              updatedAt: event.ts,
              nodes: {},
              nodeConfigs: {},
              edges: {},
              artifacts: {}
            };
            runState = { ...base, ...event.patch };
          } else {
            runState = {
              ...runState,
              ...event.patch,
              nodes: event.patch.nodes ? { ...runState.nodes, ...event.patch.nodes } : runState.nodes,
              nodeConfigs: event.patch.nodeConfigs
                ? { ...runState.nodeConfigs, ...event.patch.nodeConfigs }
                : runState.nodeConfigs,
              edges: event.patch.edges ? { ...runState.edges, ...event.patch.edges } : runState.edges,
              artifacts: event.patch.artifacts
                ? { ...runState.artifacts, ...event.patch.artifacts }
                : runState.artifacts
            };
          }
          return;
        }

        if (!runState) {
          return;
        }

        switch (event.type) {
          case "node.patch": {
            const existing = runState.nodes[event.nodeId] ?? {
              id: event.nodeId,
              runId: event.runId,
              label: "unknown",
              roleTemplate: "unknown",
              provider: "custom",
              status: "idle",
              summary: "idle",
              lastActivityAt: event.ts,
              capabilities: {
                edgeManagement: "none",
                writeCode: false,
                writeDocs: false,
                runCommands: false,
                delegateOnly: false
              },
              permissions: {
                cliPermissionsMode: "skip",
                agentManagementRequiresApproval: true
              },
              session: {
                sessionId: "pending",
                resetCommands: []
              }
            };
            runState.nodes[event.nodeId] = { ...existing, ...event.patch };
            break;
          }
          case "node.deleted":
            delete runState.nodes[event.nodeId];
            delete runState.nodeConfigs[event.nodeId];
            break;
          case "edge.created":
            runState.edges[event.edge.id] = event.edge;
            break;
          case "edge.deleted":
            delete runState.edges[event.edgeId];
            break;
          case "artifact.created":
            runState.artifacts[event.artifact.id] = event.artifact;
            break;
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to read run events", { runId, message });
      return null;
    }

    if (eventCount === 0 || !runState) {
      return null;
    }

    return runState;
  }

  private normalizePersistedRunState(runState: RunState): RunState {
    const now = nowIso();
    const layout = runState.layout ?? {
      positions: {},
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: now
    };
    const nodeConfigs: Record<UUID, NodeConfig> = { ...(runState.nodeConfigs ?? {}) };
    for (const node of Object.values(runState.nodes)) {
      if (!nodeConfigs[node.id]) {
        nodeConfigs[node.id] = this.buildNodeConfigFromState(node);
      }
    }
    const status = runState.status === "running" ? "paused" : runState.status;
    return {
      ...runState,
      status,
      updatedAt: status !== runState.status ? now : runState.updatedAt,
      layout,
      nodeConfigs
    };
  }

  private buildNodeConfigFromState(node: NodeState): NodeConfig {
    return {
      id: node.id,
      label: node.label,
      alias: node.alias,
      provider: node.provider,
      roleTemplate: node.roleTemplate,
      customSystemPrompt: node.customSystemPrompt ?? null,
      capabilities: node.capabilities,
      permissions: node.permissions,
      session: {
        resume: true,
        resetCommands: node.session.resetCommands ?? []
      }
    };
  }

  private rehydrateRun(runState: RunState): void {
    const now = nowIso();
    const record = this.store.createRun(runState);
    this.artifactStores.set(runState.id, new ArtifactStore(this.dataDir, runState.id));
    for (const node of Object.values(runState.nodes)) {
      const disconnected: NodeConnection = {
        status: "disconnected",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      };
      const hydrated: NodeState = {
        ...node,
        status: node.status === "running" ? "idle" : node.status,
        summary: node.status === "running" ? "idle" : node.summary,
        connection: node.connection ? { ...node.connection, ...disconnected } : disconnected,
        lastActivityAt: now,
        inboxCount: 0
      };
      const config = runState.nodeConfigs[hydrated.id] ?? this.buildNodeConfigFromState(hydrated);
      this.store.addNode(runState.id, hydrated, config);
      record.state.nodes[hydrated.id] = hydrated;
      record.state.nodeConfigs[hydrated.id] = config;
    }
    for (const edge of Object.values(runState.edges)) {
      this.store.addEdge(runState.id, edge);
    }
    for (const artifact of Object.values(runState.artifacts)) {
      this.store.addArtifact(runState.id, artifact);
    }
  }

  updateRun(
    runId: UUID,
    patch: Partial<Pick<RunState, "status" | "mode" | "globalMode" | "layout">>
  ): RunState {
    const record = this.requireRun(runId);
    const now = nowIso();
    const updates: Partial<RunState> = {};
    const previousStatus = record.state.status;

    if (patch.status !== undefined) {
      record.state.status = patch.status;
      updates.status = patch.status;
    }
    if (patch.mode !== undefined) {
      record.state.mode = patch.mode;
      updates.mode = patch.mode;
    }
    if (patch.globalMode !== undefined) {
      record.state.globalMode = patch.globalMode;
      updates.globalMode = patch.globalMode;
    }
    if (patch.layout) {
      const layout = {
        positions: patch.layout.positions,
        viewport: patch.layout.viewport,
        updatedAt: now
      };
      record.state.layout = layout;
      updates.layout = layout;
    }

    record.state.updatedAt = now;
    updates.updatedAt = now;

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "run.patch",
      patch: updates
    });

    if (updates.mode || updates.globalMode) {
      this.emitEvent(runId, {
        id: newId(),
        runId,
        ts: now,
        type: "run.mode",
        mode: record.state.mode,
        globalMode: record.state.globalMode
      });
    }

    if (updates.status === "paused" && previousStatus !== "paused") {
      this.interruptRun(record, now);
    }

    if (updates.status === "stopped" && previousStatus !== "stopped") {
      this.stopRun(record, now);
    }

    if (updates.status === "running" && previousStatus === "paused") {
      this.resumeInterruptedNodes(record);
    }

    void this.saveRunSnapshot(runId);
    return record.state;
  }

  async deleteRun(runId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const now = nowIso();

    if (this.snapshotTimers.has(runId)) {
      clearTimeout(this.snapshotTimers.get(runId));
      this.snapshotTimers.delete(runId);
    }

    if (this.runner.disposeNode) {
      for (const nodeRecord of record.nodes.values()) {
        nodeRecord.runtime.cancelRequested = true;
        try {
          await this.runner.disposeNode(nodeRecord.state.id);
        } catch (error) {
          this.logger.error("failed to dispose node session", {
            nodeId: nodeRecord.state.id,
            runId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    this.store.deleteRun(runId);
    this.artifactStores.delete(runId);

    try {
      await fs.rm(path.join(this.dataDir, "runs", runId), { recursive: true, force: true });
    } catch (error) {
      this.logger.error("failed to remove run data", {
        runId,
        compiler: "runtime",
        message: error instanceof Error ? error.message : String(error),
        ts: now
      });
    }
  }

  async resetNode(runId: UUID, nodeId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const nodeRecord = this.requireNode(record, nodeId);
    const now = nowIso();

    nodeRecord.runtime.pendingTurn = false;
    nodeRecord.runtime.autoPromptQueued = false;
    nodeRecord.runtime.inbox = [];
    nodeRecord.runtime.queuedMessages = [];
    nodeRecord.runtime.summaryHistory = [];
    nodeRecord.runtime.outputRepeatCount = 0;
    nodeRecord.runtime.diffRepeatCount = 0;
    nodeRecord.runtime.verificationRepeatCount = 0;
    nodeRecord.runtime.lastOutputHash = undefined;
    nodeRecord.runtime.lastDiffHash = undefined;
    nodeRecord.runtime.lastVerificationFailure = undefined;
    nodeRecord.state.inboxCount = 0;
    if (this.runner.resetNode) {
      try {
        await this.runner.resetNode(nodeId);
      } catch (error) {
        this.logger.error("failed to reset node session", {
          nodeId,
          runId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const idleConnection: NodeConnection | undefined = nodeRecord.state.connection
      ? {
        ...nodeRecord.state.connection,
        status: "idle",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      }
      : undefined;

    nodeRecord.state = {
      ...nodeRecord.state,
      status: "idle",
      summary: "context reset",
      lastActivityAt: now,
      connection: idleConnection
    };
    record.state.nodes[nodeId] = nodeRecord.state;
    record.state.updatedAt = now;

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId,
      patch: {
        status: "idle",
        summary: "context reset",
        lastActivityAt: now,
        connection: idleConnection
      }
    });

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.progress",
      nodeId,
      status: "idle",
      summary: "context reset"
    });
  }

  async startNodeProcess(runId: UUID, nodeId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const nodeRecord = this.requireNode(record, nodeId);
    const now = nowIso();

    if (!this.runner.startNode) {
      throw new Error("Runner does not support starting node sessions");
    }

    try {
      await this.runner.startNode({
        run: record.state,
        node: nodeRecord.state,
        config: nodeRecord.config
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to start node session", {
        nodeId,
        runId,
        message
      });
      throw error;
    }

    const connection: NodeConnection = nodeRecord.state.connection
      ? {
        ...nodeRecord.state.connection,
        status: "idle",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      }
      : {
        status: "idle",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      };
    const summary =
      nodeRecord.state.connection?.status === "disconnected"
        ? "process started"
        : nodeRecord.state.summary;

    nodeRecord.state = {
      ...nodeRecord.state,
      summary,
      lastActivityAt: now,
      connection
    };
    record.state.nodes[nodeId] = nodeRecord.state;
    record.state.updatedAt = now;

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId,
      patch: {
        summary,
        lastActivityAt: now,
        connection
      }
    });
  }

  async stopNodeProcess(runId: UUID, nodeId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const nodeRecord = this.requireNode(record, nodeId);
    const now = nowIso();

    if (!this.runner.stopNode) {
      throw new Error("Runner does not support stopping node sessions");
    }

    if (nodeRecord.state.status === "running") {
      nodeRecord.runtime.cancelRequested = true;
    }
    nodeRecord.runtime.pendingTurn = false;
    nodeRecord.runtime.autoPromptQueued = false;
    for (const [approvalId, approval] of record.approvals.entries()) {
      if (approval.nodeId === nodeId) {
        record.approvals.delete(approvalId);
      }
    }

    try {
      await this.runner.stopNode(nodeId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to stop node session", {
        nodeId,
        runId,
        message
      });
      throw error;
    }

    const connection: NodeConnection = nodeRecord.state.connection
      ? {
        ...nodeRecord.state.connection,
        status: "disconnected",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      }
      : {
        status: "disconnected",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      };

    nodeRecord.state = {
      ...nodeRecord.state,
      status: "idle",
      summary: "process stopped",
      lastActivityAt: now,
      connection
    };
    record.state.nodes[nodeId] = nodeRecord.state;
    record.state.updatedAt = now;

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId,
      patch: {
        status: "idle",
        summary: "process stopped",
        lastActivityAt: now,
        connection
      }
    });
  }

  async interruptNodeProcess(runId: UUID, nodeId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const nodeRecord = this.requireNode(record, nodeId);

    if (!this.runner.interruptNode) {
      throw new Error("Runner does not support interrupting node sessions");
    }

    if (nodeRecord.state.status !== "running") {
      throw new Error("Node is not running");
    }

    try {
      await this.runner.interruptNode(nodeId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to interrupt node session", {
        nodeId,
        runId,
        message
      });
      throw error;
    }
  }

  async deleteNode(runId: UUID, nodeId: UUID): Promise<void> {
    const record = this.requireRun(runId);
    const now = nowIso();
    const nodeRecord = record.nodes.get(nodeId);
    if (!nodeRecord) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (this.runner.disposeNode) {
      nodeRecord.runtime.cancelRequested = true;
      try {
        await this.runner.disposeNode(nodeId);
      } catch (error) {
        this.logger.error("failed to dispose node session", {
          nodeId,
          runId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    for (const [edgeId, edge] of record.edges.entries()) {
      if (edge.from === nodeId || edge.to === nodeId) {
        record.edges.delete(edgeId);
        delete record.state.edges[edgeId];
        this.emitEvent(runId, {
          id: newId(),
          runId,
          ts: now,
          type: "edge.deleted",
          edgeId
        });
      }
    }

    for (const [approvalId, approval] of record.approvals.entries()) {
      if (approval.nodeId === nodeId) {
        record.approvals.delete(approvalId);
      }
    }

    record.nodes.delete(nodeId);
    delete record.state.nodes[nodeId];
    delete record.state.nodeConfigs[nodeId];
    record.state.updatedAt = now;

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.deleted",
      nodeId
    });

    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "run.patch",
      patch: { updatedAt: now }
    });
    void this.saveRunSnapshot(runId);
  }

  async getArtifactContent(runId: UUID, artifactId: UUID): Promise<{ artifact: Artifact; content: string }> {
    const record = this.requireRun(runId);
    const artifact = record.artifacts.get(artifactId) ?? record.state.artifacts[artifactId];
    if (!artifact) {
      throw new Error(`Artifact ${artifactId} not found`);
    }
    const content = await fs.readFile(artifact.path, "utf8");
    return { artifact, content };
  }

  async listDirectory(dirPath?: string): Promise<ListDirectoryResponse> {
    const target = dirPath ? path.resolve(dirPath) : process.cwd();
    const entries = await fs.readdir(target, { withFileTypes: true });

    const files: FileEntry[] = entries
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        path: path.join(target, entry.name)
      }))
      .filter((entry) => !entry.name.startsWith(".")) // simple hidden filter
      .sort((a, b) => {
        if (a.isDirectory === b.isDirectory) {
          return a.name.localeCompare(b.name);
        }
        return a.isDirectory ? -1 : 1;
      });

    return {
      entries: files,
      parent: path.dirname(target) !== target ? path.dirname(target) : undefined,
      current: target
    };
  }

  createRun({
    mode = "AUTO",
    globalMode = "IMPLEMENTATION",
    cwd
  }: { mode?: OrchestrationMode; globalMode?: GlobalMode; cwd?: string }): RunState {
    const now = nowIso();
    const runState: RunState = {
      id: newId(),
      contractVersion: "1",
      status: "running",
      mode,
      globalMode,
      cwd: cwd ?? this.repoRoot,
      createdAt: now,
      updatedAt: now,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      nodes: {},
      nodeConfigs: {},
      edges: {},
      artifacts: {},
      layout: {
        positions: {},
        viewport: { x: 0, y: 0, zoom: 1 },
        updatedAt: now
      }
    };
    this.store.createRun(runState);
    this.artifactStores.set(runState.id, new ArtifactStore(this.dataDir, runState.id));
    this.emitEvent(runState.id, {
      id: newId(),
      runId: runState.id,
      ts: now,
      type: "run.patch",
      patch: runState
    });
    this.emitEvent(runState.id, {
      id: newId(),
      runId: runState.id,
      ts: now,
      type: "run.mode",
      mode: runState.mode,
      globalMode: runState.globalMode
    });
    void this.saveRunSnapshot(runState.id);
    return runState;
  }

  createNode(runId: UUID, config: NodeConfigInput): NodeState {
    const record = this.requireRun(runId);
    const now = nowIso();
    const normalized = this.normalizeNodeConfig(config);
    const nodeId = normalized.id ?? newId();
    if (normalized.alias) {
      this.assertAliasAvailable(record, normalized.alias, nodeId);
    }
    const nodeState: NodeState = {
      id: nodeId,
      runId,
      label: normalized.label,
      alias: normalized.alias,
      roleTemplate: normalized.roleTemplate,
      customSystemPrompt: normalized.customSystemPrompt ?? null,
      provider: normalized.provider,
      status: "idle",
      summary: "idle",
      lastActivityAt: now,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      capabilities: normalized.capabilities,
      permissions: normalized.permissions,
      session: {
        sessionId: "pending",
        resetCommands: normalized.session.resetCommands
      },
      connection: {
        status: "idle",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      },
      inboxCount: 0
    };
    this.store.addNode(runId, nodeState, normalized);
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId: nodeState.id,
      patch: nodeState
    });
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "run.patch",
      patch: {
        nodeConfigs: { [nodeState.id]: normalized },
        updatedAt: now
      }
    });
    this.logger.info("node config snapshot stored", {
      runId,
      nodeId: nodeState.id,
      config: normalized
    });
    void this.saveRunSnapshot(runId);
    return nodeState;
  }

  private async spawnNodeFromTool(
    runId: UUID,
    fromNodeId: UUID,
    request: SpawnNodeRequest
  ): Promise<SpawnNodeResult> {
    const record = this.requireRun(runId);
    const caller = this.requireNode(record, fromNodeId);
    this.ensureEdgeManagementForSpawn(caller);
    const { instructions, input, ...config } = request;
    const node = this.createNode(runId, config);
    const message = typeof instructions === "string" ? instructions.trim() : "";
    if (message || input) {
      const now = nowIso();
      const payload = input ? { message: message || "Spawned task", structured: input } : { message: message || "Spawned task" };
      const envelope: Envelope = {
        kind: "handoff",
        id: newId(),
        fromNodeId,
        toNodeId: node.id,
        createdAt: now,
        payload
      };
      this.deliverEnvelope(runId, envelope);
    }
    return {
      nodeId: node.id,
      label: node.label,
      alias: node.alias,
      roleTemplate: node.roleTemplate,
      provider: node.provider
    };
  }

  private async createEdgeFromTool(
    runId: UUID,
    fromNodeId: UUID,
    request: CreateEdgeRequest
  ): Promise<CreateEdgeResult> {
    const record = this.requireRun(runId);
    const caller = this.requireNode(record, fromNodeId);
    const missingNodes: string[] = [];
    const fromResolved = this.resolveNodeRef(record, request.from);
    const toResolved = this.resolveNodeRef(record, request.to);
    if (!fromResolved) {
      missingNodes.push(`from=${request.from}`);
    }
    if (!toResolved) {
      missingNodes.push(`to=${request.to}`);
    }
    if (missingNodes.length > 0) {
      throw new Error(
        `create_edge requires known node ids or aliases (${missingNodes.join(
          ", "
        )}). Use Task Payload Known nodes (id or alias).`
      );
    }
    const resolvedFrom = fromResolved ?? request.from;
    const resolvedTo = toResolved ?? request.to;
    this.ensureEdgeManagementForCreateEdge(caller, resolvedFrom, resolvedTo);
    const type = request.type ?? "handoff";
    const label = request.label ?? (type === "report" ? "report" : "task");
    const edge = this.createEdge(runId, {
      from: resolvedFrom,
      to: resolvedTo,
      bidirectional: request.bidirectional ?? true,
      type,
      label
    });
    return {
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      bidirectional: edge.bidirectional,
      type: edge.type,
      label: edge.label
    };
  }

  private async sendHandoffFromTool(
    runId: UUID,
    fromNodeId: UUID,
    request: SendHandoffRequest
  ): Promise<SendHandoffResult> {
    const record = this.requireRun(runId);
    const missingNodes: string[] = [];
    if (!record.nodes.has(fromNodeId)) {
      missingNodes.push(`from=${fromNodeId}`);
    }
    const toResolved = this.resolveNodeRef(record, request.to);
    if (!toResolved) {
      missingNodes.push(`to=${request.to}`);
    }
    if (missingNodes.length > 0) {
      throw new Error(
        `send_handoff requires known node ids or aliases (${missingNodes.join(
          ", "
        )}). Use Task Payload Known nodes (id or alias).`
      );
    }
    const resolvedTo = toResolved ?? request.to;
    if (!this.hasEdgeBetween(record, fromNodeId, resolvedTo)) {
      throw new Error(
        `send_handoff requires an edge between ${fromNodeId} and ${resolvedTo}. Create the edge first.`
      );
    }
    const now = nowIso();
    const payload: Envelope["payload"] = { message: request.message.trim() };
    if (request.structured) {
      payload.structured = request.structured;
    }
    if (request.artifacts && request.artifacts.length > 0) {
      payload.artifacts = request.artifacts;
    }
    if (request.status) {
      payload.status = request.status;
    }
    if (request.response) {
      payload.response = request.response;
    }
    const envelope: Envelope = {
      kind: "handoff",
      id: newId(),
      fromNodeId,
      toNodeId: resolvedTo,
      createdAt: now,
      payload
    };
    if (request.contextRef) {
      envelope.contextRef = request.contextRef;
    }
    this.deliverEnvelope(runId, envelope);
    return { envelopeId: envelope.id, from: fromNodeId, to: resolvedTo };
  }

  private hasEdgeBetween(record: RunRecord, from: UUID, to: UUID): boolean {
    for (const edge of record.edges.values()) {
      if (edge.from === from && edge.to === to) {
        return true;
      }
      if (edge.bidirectional && edge.from === to && edge.to === from) {
        return true;
      }
    }
    return false;
  }

  updateNode(runId: UUID, nodeId: UUID, patch: Partial<NodeState>, config?: Partial<NodeConfig>): NodeState {
    const record = this.requireRun(runId);
    const now = nowIso();
    const nodeRecord = this.requireNode(record, nodeId);
    const previousConfig = nodeRecord.config;
    let updatedPatch = { ...patch };
    let configPatch = config;

    const aliasInput =
      typeof patch.alias === "string" ? patch.alias : typeof config?.alias === "string" ? config.alias : undefined;
    if (aliasInput !== undefined) {
      const normalizedAlias = this.normalizeAlias(aliasInput);
      if (normalizedAlias) {
        this.assertAliasAvailable(record, normalizedAlias, nodeId);
      }
      updatedPatch = { ...updatedPatch, alias: normalizedAlias };
      configPatch = { ...(configPatch ?? {}), alias: normalizedAlias };
    }

    if (config?.provider && config.provider !== nodeRecord.config.provider) {
      if (this.runner.disposeNode) {
        if (nodeRecord.state.status === "running") {
          nodeRecord.runtime.cancelRequested = true;
        }
        void this.runner.disposeNode(nodeId);
      }
      if (updatedPatch.provider === undefined) {
        updatedPatch = { ...updatedPatch, provider: config.provider };
      }
      const disconnected: NodeConnection = {
        status: "disconnected",
        streaming: false,
        lastHeartbeatAt: now,
        lastOutputAt: now
      };
      updatedPatch = {
        ...updatedPatch,
        connection: nodeRecord.state.connection
          ? { ...nodeRecord.state.connection, ...disconnected }
          : disconnected
      };
    }

    const updated = this.store.updateNode(runId, nodeId, updatedPatch);
    const updatedConfig = configPatch ? this.store.updateNodeConfig(runId, nodeId, configPatch) : undefined;
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId,
      patch: updatedPatch
    });
    if (updatedConfig) {
      this.emitEvent(runId, {
        id: newId(),
        runId,
        ts: now,
        type: "run.patch",
        patch: {
          nodeConfigs: { [nodeId]: updatedConfig },
          updatedAt: now
        }
      });
      this.logger.info("node config updated", {
        runId,
        nodeId,
        previousConfig,
        updatedConfig
      });
    }
    void this.saveRunSnapshot(runId);
    return updated;
  }

  createEdge(runId: UUID, edge: Omit<EdgeState, "id"> & { id?: UUID }): EdgeState {
    const record = this.requireRun(runId);
    const now = nowIso();
    const resolved: EdgeState = {
      id: edge.id ?? newId(),
      from: edge.from,
      to: edge.to,
      bidirectional: edge.bidirectional ?? true,
      type: edge.type ?? "handoff",
      label: edge.label ?? ((edge.type ?? "handoff") === "report" ? "report" : "task")
    };
    this.store.addEdge(runId, resolved);
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "edge.created",
      edge: resolved
    });
    void this.saveRunSnapshot(runId);
    return resolved;
  }

  deleteEdge(runId: UUID, edgeId: UUID): void {
    const record = this.requireRun(runId);
    const now = nowIso();
    this.store.deleteEdge(runId, edgeId);
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "edge.deleted",
      edgeId
    });
    void this.saveRunSnapshot(runId);
  }

  postMessage(runId: UUID, nodeId: UUID, content: string, interrupt = false): UserMessageRecord {
    const record = this.requireRun(runId);
    const now = nowIso();
    const message: UserMessageRecord = {
      id: newId(),
      runId,
      nodeId,
      role: "user",
      content,
      interrupt,
      createdAt: now
    };
    this.store.enqueueMessage(runId, nodeId, message, interrupt);
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "message.user",
      message
    });
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId,
      patch: { inboxCount: this.requireNode(record, nodeId).state.inboxCount }
    });
    return message;
  }

  listApprovals(): Array<{ runId: UUID; approval: ApprovalRequest }> {
    return this.store.listApprovals();
  }

  resolveApproval(runId: UUID, approvalId: UUID, resolution: ApprovalResolution): void {
    const record = this.requireRun(runId);
    const now = nowIso();
    const approval = this.store.resolveApproval(runId, approvalId);
    if (!approval) {
      return;
    }
    const resolver = this.runner.resolveApproval?.(approvalId, resolution);
    if (resolver) {
      resolver.catch((error) => {
        this.logger.error("failed to forward approval resolution", {
          approvalId,
          runId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "approval.resolved",
      approvalId,
      resolution
    });
    this.unblockNode(record, approval.nodeId, now);
  }

  resolveApprovalById(approvalId: UUID, resolution: ApprovalResolution): void {
    const now = nowIso();
    const resolved = this.store.resolveApprovalById(approvalId);
    if (!resolved) {
      return;
    }
    const resolver = this.runner.resolveApproval?.(approvalId, resolution);
    if (resolver) {
      resolver.catch((error) => {
        this.logger.error("failed to forward approval resolution", {
          approvalId,
          runId: resolved.runId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
    this.emitEvent(resolved.runId, {
      id: newId(),
      runId: resolved.runId,
      ts: now,
      type: "approval.resolved",
      approvalId,
      resolution
    });
    const record = this.requireRun(resolved.runId);
    this.unblockNode(record, resolved.approval.nodeId, now);
  }

  async recordArtifact(
    runId: UUID,
    nodeId: UUID,
    kind: ArtifactKind,
    name: string,
    content: string,
    metadata?: ArtifactMetadata
  ): Promise<Artifact> {
    const record = this.requireRun(runId);
    const now = nowIso();
    const store = this.requireArtifactStore(runId);
    const artifactId = newId();
    const filename = `${artifactId}-${name}`;
    const path = await store.writeArtifact(filename, content);
    const artifact: Artifact = {
      id: artifactId,
      runId,
      nodeId,
      kind,
      name,
      path,
      createdAt: now,
      metadata
    };
    this.store.addArtifact(runId, artifact);
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "artifact.created",
      artifact
    });
    void this.saveRunSnapshot(runId);
    return artifact;
  }

  deliverEnvelope(runId: UUID, envelope: Envelope): void {
    const record = this.requireRun(runId);
    const now = nowIso();
    this.store.enqueueEnvelope(runId, envelope.toNodeId, envelope);
    this.touchRun(record, now);
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "handoff.sent",
      envelope
    });
    this.emitEvent(runId, {
      id: newId(),
      runId,
      ts: now,
      type: "node.patch",
      nodeId: envelope.toNodeId,
      patch: { inboxCount: this.requireNode(record, envelope.toNodeId).state.inboxCount }
    });
  }

  emitEvent(runId: UUID, event: EventEnvelope): void {
    const record = this.store.getRun(runId);
    if (!record) {
      this.logger.debug("ignoring event for missing run", {
        runId,
        type: event.type
      });
      return;
    }
    let usagePatch: { nodeId?: UUID; nodeUsage?: UsageTotals; runUsage?: UsageTotals; ts: string } | null = null;

    if (event.type === "telemetry.usage") {
      const timestamp = event.ts ?? nowIso();
      const runUsage = addUsage(record.state.usage, event.usage);
      record.state.usage = runUsage;
      record.state.updatedAt = timestamp;

      let nodeUsage: UsageTotals | undefined;
      if (event.nodeId) {
        const nodeRecord = record.nodes.get(event.nodeId);
        if (nodeRecord) {
          nodeUsage = addUsage(nodeRecord.state.usage, event.usage);
          nodeRecord.state = { ...nodeRecord.state, usage: nodeUsage };
          record.state.nodes[event.nodeId] = nodeRecord.state;
        }
      }

      usagePatch = {
        nodeId: event.nodeId,
        nodeUsage,
        runUsage,
        ts: timestamp
      };
    }
    if (event.type === "node.patch") {
      const nodeRecord = record.nodes.get(event.nodeId);
      if (nodeRecord) {
        nodeRecord.state = { ...nodeRecord.state, ...event.patch };
        record.state.nodes[event.nodeId] = nodeRecord.state;
        record.state.updatedAt = event.ts ?? nowIso();
      }
    }
    void record.eventLog.append(event).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to append run event", { runId, type: event.type, message });
    });
    this.eventBus.emit(event);

    if (usagePatch?.nodeId && usagePatch.nodeUsage) {
      this.emitEvent(runId, {
        id: newId(),
        runId,
        ts: usagePatch.ts,
        type: "node.patch",
        nodeId: usagePatch.nodeId,
        patch: { usage: usagePatch.nodeUsage }
      });
    }

    if (usagePatch?.runUsage) {
      this.emitEvent(runId, {
        id: newId(),
        runId,
        ts: usagePatch.ts,
        type: "run.patch",
        patch: { usage: usagePatch.runUsage, updatedAt: usagePatch.ts }
      });
    }
  }

  private touchRun(record: RunRecord, timestamp: string): void {
    record.state.updatedAt = timestamp;
  }

  private normalizeNodeConfig(config: NodeConfigInput): NodeConfig {
    const isOrchestrator = config.roleTemplate.trim().toLowerCase() === "orchestrator";
    return {
      id: config.id,
      label: config.label,
      alias: this.normalizeAlias(config.alias),
      provider: config.provider,
      roleTemplate: config.roleTemplate,
      customSystemPrompt: config.customSystemPrompt ?? null,
      capabilities: {
        edgeManagement: this.resolveEdgeManagement(config.capabilities?.edgeManagement, isOrchestrator),
        writeCode: config.capabilities?.writeCode ?? true,
        writeDocs: config.capabilities?.writeDocs ?? true,
        runCommands: config.capabilities?.runCommands ?? true,
        delegateOnly: config.capabilities?.delegateOnly ?? false
      },
      permissions: {
        cliPermissionsMode: config.permissions?.cliPermissionsMode ?? "skip",
        agentManagementRequiresApproval:
          config.permissions?.agentManagementRequiresApproval ?? !isOrchestrator
      },
      session: {
        resume: config.session?.resume ?? true,
        resetCommands: config.session?.resetCommands ?? ["/new", "/clear"]
      }
    };
  }

  private resolveEdgeManagement(
    value: EdgeManagementScope | undefined,
    isOrchestrator: boolean
  ): EdgeManagementScope {
    if (value === "none" || value === "self" || value === "all") {
      return value;
    }
    return isOrchestrator ? "all" : "none";
  }

  private ensureEdgeManagementForSpawn(nodeRecord: NodeRecord): void {
    const scope = nodeRecord.state.capabilities.edgeManagement;
    if (scope === "all") {
      return;
    }
    this.logger.warn("spawn_node blocked by edgeManagement", {
      runId: nodeRecord.state.runId,
      nodeId: nodeRecord.state.id,
      label: nodeRecord.state.label,
      edgeManagement: scope
    });
    throw new Error("edgeManagement=all required to spawn nodes");
  }

  private ensureEdgeManagementForCreateEdge(nodeRecord: NodeRecord, from: UUID, to: UUID): void {
    const scope = nodeRecord.state.capabilities.edgeManagement;
    if (scope === "all") {
      return;
    }
    if (scope === "none") {
      this.logger.warn("create_edge blocked by edgeManagement", {
        runId: nodeRecord.state.runId,
        nodeId: nodeRecord.state.id,
        label: nodeRecord.state.label,
        edgeManagement: scope,
        from,
        to
      });
      throw new Error("edgeManagement capability is disabled");
    }
    if (from !== nodeRecord.state.id && to !== nodeRecord.state.id) {
      this.logger.warn("create_edge blocked by edgeManagement=self", {
        runId: nodeRecord.state.runId,
        nodeId: nodeRecord.state.id,
        label: nodeRecord.state.label,
        edgeManagement: scope,
        from,
        to
      });
      throw new Error("edgeManagement=self only allows edges that include the calling node");
    }
  }

  private normalizeAlias(value?: string | null): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private assertAliasAvailable(record: RunRecord, alias: string, nodeId?: UUID): void {
    const normalized = alias.toLowerCase();
    if (nodeId && nodeId.toLowerCase() === normalized) {
      this.logger.warn("node alias conflicts with node id", {
        runId: record.state.id,
        alias,
        nodeId
      });
      throw new Error(`alias "${alias}" conflicts with node id ${nodeId}`);
    }
    for (const node of record.nodes.values()) {
      if (nodeId && node.state.id === nodeId) {
        continue;
      }
      if (node.state.id.toLowerCase() === normalized) {
        this.logger.warn("node alias conflicts with existing node id", {
          runId: record.state.id,
          alias,
          nodeId: node.state.id
        });
        throw new Error(`alias "${alias}" conflicts with node id ${node.state.id}`);
      }
      const existingAlias = node.state.alias;
      if (existingAlias && existingAlias.toLowerCase() === normalized) {
        this.logger.warn("node alias already in use", {
          runId: record.state.id,
          alias,
          nodeId: node.state.id,
          label: node.state.label
        });
        throw new Error(`alias "${alias}" is already in use by ${node.state.label} (${node.state.id})`);
      }
    }
  }

  private resolveNodeRef(record: RunRecord, ref: string): UUID | null {
    const trimmed = ref.trim();
    if (!trimmed) {
      return null;
    }
    if (record.nodes.has(trimmed)) {
      return trimmed;
    }
    const target = trimmed.toLowerCase();
    for (const node of record.nodes.values()) {
      const alias = node.state.alias;
      if (alias && alias.toLowerCase() === target) {
        return node.state.id;
      }
    }
    return null;
  }

  private requireRun(runId: UUID): RunRecord {
    const record = this.store.getRun(runId);
    if (!record) {
      throw new Error(`Run ${runId} not found`);
    }
    return record;
  }

  private requireNode(record: RunRecord, nodeId: UUID): NodeRecord {
    const nodeRecord = record.nodes.get(nodeId);
    if (!nodeRecord) {
      throw new Error(`Node ${nodeId} not found`);
    }
    return nodeRecord;
  }

  private requireArtifactStore(runId: UUID): ArtifactStore {
    const store = this.artifactStores.get(runId);
    if (!store) {
      const newStore = new ArtifactStore(this.dataDir, runId);
      this.artifactStores.set(runId, newStore);
      return newStore;
    }
    return store;
  }

  private unblockNode(record: RunRecord, nodeId: UUID, now: string): void {
    const nodeRecord = record.nodes.get(nodeId);
    if (!nodeRecord) {
      return;
    }
    nodeRecord.runtime.pendingTurn = true;
    nodeRecord.state.status = "idle";
    nodeRecord.state.summary = "approval resolved";
    nodeRecord.state.lastActivityAt = now;
    record.state.nodes[nodeId] = nodeRecord.state;
    record.state.updatedAt = now;
    this.emitEvent(record.state.id, {
      id: newId(),
      runId: record.state.id,
      ts: now,
      type: "node.patch",
      nodeId,
      patch: {
        status: "idle",
        summary: "approval resolved",
        lastActivityAt: now
      }
    });
    this.emitEvent(record.state.id, {
      id: newId(),
      runId: record.state.id,
      ts: now,
      type: "node.progress",
      nodeId,
      status: "idle",
      summary: "approval resolved"
    });
  }

  private interruptRun(record: RunRecord, now: string): void {
    for (const nodeRecord of record.nodes.values()) {
      const nodeId = nodeRecord.state.id;
      const wasRunning = nodeRecord.state.status === "running";
      nodeRecord.runtime.pendingTurn = false;
      nodeRecord.runtime.wasInterrupted = wasRunning;
      const connection: NodeConnection | undefined = nodeRecord.state.connection
        ? {
          ...nodeRecord.state.connection,
          status: "idle",
          streaming: false,
          lastHeartbeatAt: now,
          lastOutputAt: now
        }
        : undefined;
      const summary = wasRunning ? "interrupted" : "paused";
      nodeRecord.state = {
        ...nodeRecord.state,
        status: "idle",
        summary,
        lastActivityAt: now,
        connection
      };
      record.state.nodes[nodeId] = nodeRecord.state;
      this.emitEvent(record.state.id, {
        id: newId(),
        runId: record.state.id,
        ts: now,
        type: "node.patch",
        nodeId,
        patch: {
          status: "idle",
          summary,
          lastActivityAt: now,
          connection
        }
      });
      if (wasRunning && this.runner.interruptNode) {
        this.runner.interruptNode(nodeId).catch((error) => {
          this.logger.error("failed to interrupt node session", {
            nodeId,
            runId: record.state.id,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }
  }

  private resumeInterruptedNodes(record: RunRecord): void {
    for (const nodeRecord of record.nodes.values()) {
      const nodeId = nodeRecord.state.id;
      if (!nodeRecord.runtime.wasInterrupted) {
        continue;
      }
      nodeRecord.runtime.wasInterrupted = false;
      this.postMessage(record.state.id, nodeId, "Continue.", true);
    }
  }

  private stopRun(record: RunRecord, now: string): void {
    for (const nodeRecord of record.nodes.values()) {
      const nodeId = nodeRecord.state.id;
      nodeRecord.runtime.pendingTurn = false;
      nodeRecord.runtime.autoPromptQueued = false;
      nodeRecord.runtime.wasInterrupted = false;
      const connection: NodeConnection | undefined = nodeRecord.state.connection
        ? {
          ...nodeRecord.state.connection,
          status: "disconnected",
          streaming: false,
          lastHeartbeatAt: now,
          lastOutputAt: now
        }
        : undefined;
      nodeRecord.state = {
        ...nodeRecord.state,
        status: "idle",
        summary: "stopped",
        lastActivityAt: now,
        connection
      };
      record.state.nodes[nodeId] = nodeRecord.state;
      this.emitEvent(record.state.id, {
        id: newId(),
        runId: record.state.id,
        ts: now,
        type: "node.patch",
        nodeId,
        patch: {
          status: "idle",
          summary: "stopped",
          lastActivityAt: now,
          connection
        }
      });
      if (this.runner.stopNode) {
        this.runner.stopNode(nodeId).catch((error) => {
          this.logger.error("failed to stop node session", {
            nodeId,
            runId: record.state.id,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }
  }
}
