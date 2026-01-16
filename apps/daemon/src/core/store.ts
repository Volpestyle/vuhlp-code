import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ArtifactRecord,
  RunRecord,
  VuhlpEvent,
  NodeRecord,
  EdgeRecord,
  RunMode,
  GlobalMode,
  RunPolicy,
  RunPhase,
} from "./types.js";
import { nowIso } from "./time.js";

export interface RunStoreOptions {
  dataDir: string; // absolute or relative
}

export class RunStore {
  private dataDir: string;

  // In-memory cache for active runs.
  private runs: Map<string, RunRecord> = new Map();

  constructor(opts: RunStoreOptions) {
    this.dataDir = path.resolve(opts.dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(path.join(this.dataDir, "runs"), { recursive: true });
  }

  getDataDir(): string {
    return this.dataDir;
  }

  listRuns(): RunRecord[] {
    // Merge on-disk runs with in-memory cache.
    const runsDir = path.join(this.dataDir, "runs");
    const ids = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const out: RunRecord[] = [];
    for (const id of ids) {
      const cached = this.runs.get(id);
      if (cached) {
        out.push(cached);
        continue;
      }
      const runPath = path.join(runsDir, id, "run.json");
      if (!fs.existsSync(runPath)) continue;
      try {
        const run = JSON.parse(fs.readFileSync(runPath, "utf-8")) as RunRecord;
        out.push(run);
      } catch {
        // ignore corrupted
      }
    }
    // sort newest first
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }

  getRun(runId: string): RunRecord | null {
    const cached = this.runs.get(runId);
    if (cached) return cached;

    const runPath = this.runFilePath(runId);
    if (!fs.existsSync(runPath)) return null;
    const run = JSON.parse(fs.readFileSync(runPath, "utf-8")) as RunRecord;
    this.runs.set(runId, run);
    return run;
  }

  createRun(params: {
    prompt: string;
    repoPath: string;
    maxIterations: number;
    config: Record<string, unknown>;
    /** Initial run mode. Defaults to AUTO. */
    mode?: RunMode;
    /** Initial global mode. Defaults to PLANNING. */
    globalMode?: GlobalMode;
    /** Run-level policy configuration. */
    policy?: RunPolicy;
  }): RunRecord {
    const id = randomUUID();
    const createdAt = nowIso();
    const runsDir = path.join(this.dataDir, "runs");
    const runDir = path.join(runsDir, id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });

    const rootOrchestratorNodeId = randomUUID();

    const run: RunRecord = {
      id,
      prompt: params.prompt,
      repoPath: params.repoPath,
      status: "queued",
      phase: "BOOT",
      mode: params.mode ?? "AUTO",
      globalMode: params.globalMode ?? "PLANNING",
      createdAt,
      updatedAt: createdAt,
      iterations: 0,
      maxIterations: params.maxIterations,
      config: params.config,
      policy: params.policy,
      rootOrchestratorNodeId,
      nodes: {},
      edges: {},
      artifacts: {},
      chatMessages: [],
    };

    // Create root orchestrator node upfront (as state, events emitted by Orchestrator).
    const rootNode: NodeRecord = {
      id: rootOrchestratorNodeId,
      runId: id,
      type: "orchestrator",
      label: "Root Orchestrator",
      status: "queued",
      createdAt,
      // Fix visual issue: ensure provider ID is set so the UI shows the logo.
      // Default to the 'implementer' role's provider since Root acts as a generalist.
      providerId: (params.config.roles as Record<string, string>)?.orchestrator ??
        (params.config.roles as Record<string, string>)?.implementer ??
        "mock",
    };
    run.nodes[rootNode.id] = rootNode;

    this.runs.set(id, run);
    this.persistRun(run);
    this.appendEvent(id, {
      id: randomUUID(),
      runId: id,
      ts: createdAt,
      type: "run.created",
      run: { id, prompt: params.prompt, repoPath: params.repoPath, status: "queued" },
    } as any);

    return run;
  }

  /** Persist the run materialized state. */
  persistRun(run: RunRecord): void {
    const p = this.runFilePath(run.id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(run, null, 2), "utf-8");
  }

  appendEvent(runId: string, event: VuhlpEvent): void {
    const p = this.eventsFilePath(runId);
    fs.appendFileSync(p, JSON.stringify(event) + "\n", "utf-8");
  }

  createArtifact(params: {
    runId: string;
    nodeId: string;
    kind: ArtifactRecord["kind"];
    name: string;
    mimeType: string;
    content: string | Buffer;
    meta?: Record<string, unknown>;
  }): ArtifactRecord {
    const run = this.getRun(params.runId);
    if (!run) throw new Error(`Run not found: ${params.runId}`);

    const id = randomUUID();
    const createdAt = nowIso();
    const runDir = this.runDir(params.runId);
    const artifactsDir = path.join(runDir, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });

    const safeName = params.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${createdAt.replace(/[:.]/g, "-")}_${id}_${safeName}`;
    const absPath = path.join(artifactsDir, filename);

    fs.writeFileSync(absPath, params.content);

    const artifact: ArtifactRecord = {
      id,
      runId: params.runId,
      nodeId: params.nodeId,
      kind: params.kind,
      name: params.name,
      mimeType: params.mimeType,
      path: absPath,
      createdAt,
      meta: params.meta,
    };

    run.artifacts[id] = artifact;
    run.updatedAt = createdAt;
    this.persistRun(run);

    return artifact;
  }

  runDir(runId: string): string {
    return path.join(this.dataDir, "runs", runId);
  }

  runFilePath(runId: string): string {
    return path.join(this.runDir(runId), "run.json");
  }

  eventsFilePath(runId: string): string {
    return path.join(this.runDir(runId), "events.jsonl");
  }

  /**
   * Delete a run from memory and disk.
   */
  deleteRun(runId: string): boolean {
    // Remove from memory
    this.runs.delete(runId);

    // Remove from disk
    const dir = this.runDir(runId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    }
    return false;
  }

  /**
   * Delete multiple runs.
   */
  deleteRuns(runIds: string[]): number {
    let count = 0;
    for (const runId of runIds) {
      if (this.deleteRun(runId)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all runs from memory and disk.
   */
  clearAllRuns(): number {
    const runs = this.listRuns();
    let count = 0;
    for (const run of runs) {
      if (this.deleteRun(run.id)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Archive a run (soft-delete).
   */
  archiveRun(runId: string): RunRecord | null {
    const run = this.getRun(runId);
    if (!run) return null;

    run.archived = true;
    run.archivedAt = nowIso();
    run.updatedAt = nowIso();

    this.runs.set(runId, run);
    this.persistRun(run);
    return run;
  }

  /**
   * Unarchive a run.
   */
  unarchiveRun(runId: string): RunRecord | null {
    const run = this.getRun(runId);
    if (!run) return null;

    run.archived = false;
    run.archivedAt = undefined;
    run.updatedAt = nowIso();

    this.runs.set(runId, run);
    this.persistRun(run);
    return run;
  }

  /**
   * Rename a run.
   * Pass empty string or undefined to clear the name.
   */
  renameRun(runId: string, name: string | undefined): RunRecord | null {
    const run = this.getRun(runId);
    if (!run) return null;

    run.name = name?.trim() || undefined;
    run.updatedAt = nowIso();

    this.runs.set(runId, run);
    this.persistRun(run);
    return run;
  }

  /**
   * Generic update for run properties.
   */
  updateRun(runId: string, patch: Partial<RunRecord>): RunRecord | null {
    const run = this.getRun(runId);
    if (!run) return null;

    Object.assign(run, patch);
    run.updatedAt = nowIso();

    this.runs.set(runId, run);
    this.persistRun(run);
    return run;
  }

  /**
   * List runs with optional archived filter.
   */
  listRunsFiltered(includeArchived: boolean = false): RunRecord[] {
    const all = this.listRuns();
    if (includeArchived) {
      return all;
    }
    return all.filter((run) => !run.archived);
  }

  addEdge(runId: string, edge: EdgeRecord): void {
    const run = this.getRun(runId);
    if (!run) return;
    run.edges[edge.id] = edge;
    this.persistRun(run);
  }

  removeEdge(runId: string, edgeId: string): EdgeRecord | null {
    const run = this.getRun(runId);
    if (!run) return null;
    const edge = run.edges[edgeId];
    if (!edge) return null;
    delete run.edges[edgeId];
    this.persistRun(run);
    return edge;
  }

  updateEdge(runId: string, edgeId: string, patch: Partial<EdgeRecord>): EdgeRecord | null {
    const run = this.getRun(runId);
    if (!run) return null;
    const edge = run.edges[edgeId];
    if (!edge) return null;

    Object.assign(edge, patch);
    run.updatedAt = nowIso();

    this.persistRun(run);
    return edge;
  }

  updateNode(runId: string, nodeId: string, patch: Partial<NodeRecord>): NodeRecord | null {
    const run = this.getRun(runId);
    if (!run) return null;
    const node = run.nodes[nodeId];
    if (!node) return null;

    Object.assign(node, patch);
    run.updatedAt = nowIso();

    this.persistRun(run);
    return node;
  }

  addChatMessage(runId: string, message: import("./types.js").ChatMessageRecord): void {
    const run = this.getRun(runId);
    if (!run) return;

    // Initialize if missing (e.g. migration)
    if (!run.chatMessages) run.chatMessages = [];

    run.chatMessages.push(message);
    run.updatedAt = nowIso();

    // We don't want to rewrite the whole run file for every message if we can avoid it,
    // but for now, safety first.
    this.persistRun(run);
  }
}
