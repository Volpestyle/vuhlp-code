import path from "node:path";
import { readFile, writeFile, mkdir, readdir, stat, appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import { zipSync } from "fflate";
import {
  newRunId,
  newSessionId,
  newAttachmentId,
  newTurnId,
} from "../util/id";
import type { Event, Run, Step } from "./models";
import type {
  ApprovalDecision,
  Message,
  Session,
  SessionEvent,
  Turn,
} from "./session_models";

interface ApprovalWaiter {
  resolve: () => void;
  promise: Promise<void>;
}

interface SessionApprovalWaiter {
  resolve: (decision: ApprovalDecision) => void;
  promise: Promise<ApprovalDecision>;
}

export class Store {
  private dataDir: string;
  private runs = new Map<string, Run>();
  private sessions = new Map<string, Session>();
  private subs = new Map<string, Set<(ev: Event) => void>>();
  private sessionSubs = new Map<string, Set<(ev: SessionEvent) => void>>();
  private approvals = new Map<string, Map<string, ApprovalWaiter>>();
  private sessionApprovals = new Map<string, Map<string, SessionApprovalWaiter>>();
  private cancels = new Map<string, AbortController>();
  private sessionCancels = new Map<string, AbortController>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  dataDirectory(): string {
    return this.dataDir;
  }

  async init(): Promise<void> {
    if (!this.dataDir) throw new Error("dataDir is empty");
    await mkdir(path.join(this.dataDir, "runs"), { recursive: true, mode: 0o755 });
    await mkdir(path.join(this.dataDir, "sessions"), { recursive: true, mode: 0o755 });
    await this.loadExisting();
  }

  private async loadExisting(): Promise<void> {
    await this.loadExistingRuns();
    await this.loadExistingSessions();
  }

  private async loadExistingRuns(): Promise<void> {
    const runsDir = path.join(this.dataDir, "runs");
    let entries: string[] = [];
    try {
      entries = await readdir(runsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const runPath = path.join(runsDir, entry, "run.json");
      try {
        const raw = await readFile(runPath, "utf8");
        const run = JSON.parse(raw) as Run;
        this.runs.set(run.id, run);
      } catch {
        continue;
      }
    }
  }

  private async loadExistingSessions(): Promise<void> {
    const sessionsDir = path.join(this.dataDir, "sessions");
    let entries: string[] = [];
    try {
      entries = await readdir(sessionsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const sessionPath = path.join(sessionsDir, entry, "session.json");
      try {
        const raw = await readFile(sessionPath, "utf8");
        const session = JSON.parse(raw) as Session;
        this.sessions.set(session.id, session);
      } catch {
        continue;
      }
    }
  }

  private runDir(runId: string): string {
    return path.join(this.dataDir, "runs", runId);
  }

  private runPath(runId: string): string {
    return path.join(this.runDir(runId), "run.json");
  }

  private eventsPath(runId: string): string {
    return path.join(this.runDir(runId), "events.ndjson");
  }

  async createRun(workspacePath: string, specPath: string): Promise<Run> {
    if (!workspacePath.trim()) throw new Error("workspacePath is empty");
    if (!specPath.trim()) throw new Error("specPath is empty");
    const run: Run = {
      id: newRunId(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "queued",
      workspace_path: workspacePath,
      spec_path: specPath,
    };
    const dir = this.runDir(run.id);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await writeFile(this.eventsPath(run.id), "", { mode: 0o644 });
    await this.saveRun(run);
    this.runs.set(run.id, run);
    await this.appendEvent(run.id, {
      ts: new Date().toISOString(),
      run_id: run.id,
      type: "run_created",
      data: { workspace_path: workspacePath, spec_path: specPath },
    });
    return run;
  }

  private async saveRun(run: Run): Promise<void> {
    run.updated_at = new Date().toISOString();
    const payload = JSON.stringify(run, null, 2) + "\n";
    await writeFile(this.runPath(run.id), payload, { mode: 0o644 });
  }

  async updateRun(run: Run): Promise<void> {
    if (!run) throw new Error("run is nil");
    this.runs.set(run.id, run);
    await this.saveRun(run);
  }

  async getRun(runId: string): Promise<Run> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    return structuredClone(run);
  }

  async listRuns(): Promise<Run[]> {
    const runs = Array.from(this.runs.values());
    runs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return runs.map((run) => structuredClone(run));
  }

  async appendEvent(runId: string, ev: Event): Promise<void> {
    const event = { ...ev, ts: new Date(ev.ts ?? new Date().toISOString()).toISOString(), run_id: ev.run_id || runId };
    const line = JSON.stringify(event) + "\n";
    await appendFile(this.eventsPath(runId), line, { encoding: "utf8" });
    const subs = this.subs.get(runId);
    if (subs) {
      for (const handler of subs) {
        handler(event);
      }
    }
  }

  subscribe(runId: string, handler: (ev: Event) => void): () => void {
    if (!this.subs.has(runId)) {
      this.subs.set(runId, new Set());
    }
    this.subs.get(runId)!.add(handler);
    return () => {
      this.subs.get(runId)?.delete(handler);
    };
  }

  async readEvents(runId: string, max: number): Promise<Event[]> {
    const filePath = this.eventsPath(runId);
    const out: Event[] = [];
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Event);
      } catch {
        continue;
      }
      if (max > 0 && out.length >= max) break;
    }
    return out;
  }

  async requireApproval(runId: string, stepId: string): Promise<void> {
    if (!runId || !stepId) throw new Error("runId and stepId required");
    if (!this.approvals.has(runId)) {
      this.approvals.set(runId, new Map());
    }
    const map = this.approvals.get(runId)!;
    if (map.has(stepId)) {
      throw new Error(`approval already pending for step ${stepId}`);
    }
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    map.set(stepId, { resolve, promise });
  }

  async approve(runId: string, stepId: string): Promise<void> {
    const map = this.approvals.get(runId);
    if (!map) throw new Error(`no approvals pending for run ${runId}`);
    const entry = map.get(stepId);
    if (!entry) throw new Error(`no approval pending for step ${stepId}`);
    entry.resolve();
    map.delete(stepId);
  }

  async waitForApproval(runId: string, stepId: string, signal?: AbortSignal): Promise<void> {
    const map = this.approvals.get(runId);
    const entry = map?.get(stepId);
    if (!entry) throw new Error(`no approval pending for step ${stepId}`);
    if (!signal) {
      await entry.promise;
      return;
    }
    await Promise.race([
      entry.promise,
      new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      }),
    ]);
  }

  setRunCancel(runId: string, controller: AbortController): void {
    this.cancels.set(runId, controller);
  }

  cancelRun(runId: string): void {
    const controller = this.cancels.get(runId);
    controller?.abort();
  }

  async exportRun(runId: string): Promise<Uint8Array> {
    const dir = this.runDir(runId);
    await stat(dir);
    const files: Record<string, Uint8Array> = {};
    const runJson = await readFile(this.runPath(runId));
    const events = await readFile(this.eventsPath(runId));
    files["run.json"] = runJson;
    files["events.ndjson"] = events;

    const artifactsDir = path.join(dir, "artifacts");
    await this.addDirToZip(dir, artifactsDir, files);
    return zipSync(files, { level: 6 });
  }

  // Session helpers
  private sessionsDir(): string {
    return path.join(this.dataDir, "sessions");
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.sessionsDir(), sessionId);
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "session.json");
  }

  private sessionEventsPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "events.ndjson");
  }

  private sessionAttachmentsDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "attachments");
  }

  private sessionArtifactsDir(sessionId: string, turnId: string): string {
    return path.join(this.sessionDir(sessionId), "artifacts", turnId);
  }

  async createSession(
    workspacePath: string,
    systemPrompt: string,
    mode: string,
    specPath: string,
  ): Promise<Session> {
    if (!workspacePath.trim()) throw new Error("workspacePath is empty");
    const session: Session = {
      id: newSessionId(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "active",
      mode: (mode || "chat") as "chat" | "spec",
      workspace_path: workspacePath,
      system_prompt: systemPrompt?.trim() || "",
      spec_path: specPath?.trim() || "",
      messages: [],
      turns: [],
    };
    const dir = this.sessionDir(session.id);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await writeFile(this.sessionEventsPath(session.id), "", { mode: 0o644 });
    await this.saveSession(session);
    this.sessions.set(session.id, session);
    await this.appendSessionEvent(session.id, {
      ts: new Date().toISOString(),
      session_id: session.id,
      type: "session_created",
      data: { workspace_path: workspacePath },
    });
    return session;
  }

  private async saveSession(session: Session): Promise<void> {
    session.updated_at = new Date().toISOString();
    const payload = JSON.stringify(session, null, 2) + "\n";
    await writeFile(this.sessionPath(session.id), payload, { mode: 0o644 });
  }

  async updateSession(session: Session): Promise<void> {
    if (!session) throw new Error("session is nil");
    this.sessions.set(session.id, session);
    await this.saveSession(session);
  }

  async getSession(sessionId: string): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    return structuredClone(session);
  }

  async listSessions(): Promise<Session[]> {
    const sessions = Array.from(this.sessions.values());
    sessions.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return sessions.map((session) => structuredClone(session));
  }

  async appendMessage(sessionId: string, msg: Message): Promise<Session> {
    const session = await this.getSession(sessionId);
    session.messages = session.messages ?? [];
    session.messages.push(msg);
    await this.updateSession(session);
    return session;
  }

  async addTurn(sessionId: string): Promise<string> {
    const session = await this.getSession(sessionId);
    const turn: Turn = { id: newTurnId(), status: "pending" };
    session.turns = session.turns ?? [];
    session.turns.push(turn);
    session.last_turn_id = turn.id;
    await this.updateSession(session);
    return turn.id;
  }

  async appendSessionEvent(sessionId: string, ev: SessionEvent): Promise<void> {
    const event = {
      ...ev,
      ts: new Date(ev.ts ?? new Date().toISOString()).toISOString(),
      session_id: ev.session_id || sessionId,
    };
    const line = JSON.stringify(event) + "\n";
    await appendFile(this.sessionEventsPath(sessionId), line, { encoding: "utf8" });
    const subs = this.sessionSubs.get(sessionId);
    if (subs) {
      for (const handler of subs) {
        handler(event);
      }
    }
  }

  subscribeSession(sessionId: string, handler: (ev: SessionEvent) => void): () => void {
    if (!this.sessionSubs.has(sessionId)) {
      this.sessionSubs.set(sessionId, new Set());
    }
    this.sessionSubs.get(sessionId)!.add(handler);
    return () => {
      this.sessionSubs.get(sessionId)?.delete(handler);
    };
  }

  async readSessionEvents(sessionId: string, max: number): Promise<SessionEvent[]> {
    const filePath = this.sessionEventsPath(sessionId);
    const out: SessionEvent[] = [];
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SessionEvent);
      } catch {
        continue;
      }
      if (max > 0 && out.length >= max) break;
    }
    return out;
  }

  async saveSessionAttachment(
    sessionId: string,
    filename: string,
    mimeType: string,
    content: Uint8Array,
  ): Promise<{ ref: string; mime_type: string }>
  {
    if (!sessionId) throw new Error("sessionId required");
    const dir = this.sessionAttachmentsDir(sessionId);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    let name = filename?.trim() || newAttachmentId();
    name = path.basename(name);
    if (name === "." || name === path.sep) {
      name = newAttachmentId();
    }
    if (!mimeType) mimeType = "application/octet-stream";
    const ext = path.extname(name);
    if (!ext) name = `${name}.bin`;

    let target = path.join(dir, name);
    try {
      await stat(target);
      name = `${newAttachmentId()}${ext}`;
      target = path.join(dir, name);
    } catch {
      // ok
    }
    await writeFile(target, content, { mode: 0o644 });
    return { ref: path.posix.join("attachments", name), mime_type: mimeType };
  }

  async requireSessionApproval(sessionId: string, toolCallId: string): Promise<void> {
    if (!sessionId || !toolCallId) throw new Error("sessionId and toolCallId required");
    if (!this.sessionApprovals.has(sessionId)) {
      this.sessionApprovals.set(sessionId, new Map());
    }
    const map = this.sessionApprovals.get(sessionId)!;
    if (map.has(toolCallId)) {
      throw new Error(`approval already pending for tool call ${toolCallId}`);
    }
    let resolve!: (decision: ApprovalDecision) => void;
    const promise = new Promise<ApprovalDecision>((res) => {
      resolve = res;
    });
    map.set(toolCallId, { resolve, promise });
  }

  async approveSessionToolCall(sessionId: string, toolCallId: string, decision: ApprovalDecision): Promise<void> {
    const map = this.sessionApprovals.get(sessionId);
    if (!map) throw new Error(`no approvals pending for session ${sessionId}`);
    const entry = map.get(toolCallId);
    if (!entry) throw new Error(`no approval pending for tool call ${toolCallId}`);
    entry.resolve(decision);
    map.delete(toolCallId);
  }

  async waitForSessionApproval(
    sessionId: string,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    const map = this.sessionApprovals.get(sessionId);
    const entry = map?.get(toolCallId);
    if (!entry) throw new Error(`no approval pending for tool call ${toolCallId}`);
    if (!signal) {
      return entry.promise;
    }
    return await Promise.race([
      entry.promise,
      new Promise<ApprovalDecision>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      }),
    ]);
  }

  setSessionCancel(sessionId: string, controller: AbortController): void {
    this.sessionCancels.set(sessionId, controller);
  }

  async cancelSession(sessionId: string): Promise<void> {
    this.sessionCancels.get(sessionId)?.abort();
    const session = await this.getSession(sessionId).catch(() => null);
    if (!session) return;
    if (session.status === "active" || session.status === "waiting_approval") {
      session.status = "canceled";
      if (!session.error) session.error = "canceled";
      await this.updateSession(session);
    }
  }

  async exportSession(sessionId: string): Promise<Uint8Array> {
    const dir = this.sessionDir(sessionId);
    await stat(dir);
    const files: Record<string, Uint8Array> = {};
    files["session.json"] = await readFile(this.sessionPath(sessionId));
    files["events.ndjson"] = await readFile(this.sessionEventsPath(sessionId));
    await this.addDirToZip(dir, path.join(dir, "attachments"), files);
    await this.addDirToZip(dir, path.join(dir, "artifacts"), files);
    return zipSync(files, { level: 6 });
  }

  sessionArtifactsPath(sessionId: string, turnId: string, name: string): string {
    return path.join(this.sessionArtifactsDir(sessionId, turnId), name);
  }

  async ensureSessionArtifactsDir(sessionId: string, turnId: string): Promise<void> {
    await mkdir(this.sessionArtifactsDir(sessionId, turnId), { recursive: true, mode: 0o755 });
  }

  private async addDirToZip(
    root: string,
    dir: string,
    files: Record<string, Uint8Array>,
  ): Promise<void> {
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) return;
    } catch {
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.addDirToZip(root, full, files);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.posix.join(...path.relative(root, full).split(path.sep));
      files[rel] = await readFile(full);
    }
  }
}
