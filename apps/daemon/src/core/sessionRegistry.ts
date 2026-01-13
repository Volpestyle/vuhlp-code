import fs from "node:fs";
import path from "node:path";
import { SessionRecord } from "./types.js";
import { nowIso } from "./time.js";

/**
 * SessionRegistry manages provider-native session IDs for multi-turn conversations.
 *
 * Each provider (Codex, Claude, Gemini) has its own session identifier:
 * - Codex: thread_id from JSONL events
 * - Claude: session_id from stream-json output or --session-id flag
 * - Gemini: session_id from init event in stream-json
 *
 * The registry persists sessions to disk and allows resuming conversations
 * across daemon restarts.
 */
export class SessionRegistry {
  private dataDir: string;
  private sessions: Map<string, SessionRecord> = new Map();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.load();
  }

  private get filePath(): string {
    return path.join(this.dataDir, "sessions.json");
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        if (Array.isArray(data)) {
          for (const record of data) {
            if (record.nodeId && record.providerSessionId) {
              this.sessions.set(record.nodeId, record);
            }
          }
        }
      }
    } catch {
      // Ignore load errors, start fresh
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.sessions.values());
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      // Ignore persist errors
    }
  }

  /**
   * Register a new session mapping from internal nodeId to provider session ID.
   */
  register(params: {
    nodeId: string;
    runId: string;
    providerId: string;
    providerSessionId: string;
  }): SessionRecord {
    const record: SessionRecord = {
      nodeId: params.nodeId,
      runId: params.runId,
      providerId: params.providerId,
      providerSessionId: params.providerSessionId,
      createdAt: nowIso(),
      lastUsedAt: nowIso(),
    };
    this.sessions.set(params.nodeId, record);
    this.persist();
    return record;
  }

  /**
   * Get session record by nodeId.
   */
  getByNodeId(nodeId: string): SessionRecord | undefined {
    return this.sessions.get(nodeId);
  }

  /**
   * Get session record by provider session ID.
   */
  getByProviderSessionId(providerId: string, providerSessionId: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.providerId === providerId && record.providerSessionId === providerSessionId) {
        return record;
      }
    }
    return undefined;
  }

  /**
   * Get all sessions for a run.
   */
  getByRunId(runId: string): SessionRecord[] {
    const results: SessionRecord[] = [];
    for (const record of this.sessions.values()) {
      if (record.runId === runId) {
        results.push(record);
      }
    }
    return results;
  }

  /**
   * Update the lastUsedAt timestamp when a session is resumed.
   */
  touch(nodeId: string): void {
    const record = this.sessions.get(nodeId);
    if (record) {
      record.lastUsedAt = nowIso();
      this.persist();
    }
  }

  /**
   * Remove a session (e.g., when node is deleted or session expires).
   */
  remove(nodeId: string): boolean {
    const existed = this.sessions.delete(nodeId);
    if (existed) {
      this.persist();
    }
    return existed;
  }

  /**
   * Remove all sessions for a run.
   */
  removeByRunId(runId: string): number {
    let count = 0;
    for (const [nodeId, record] of this.sessions) {
      if (record.runId === runId) {
        this.sessions.delete(nodeId);
        count++;
      }
    }
    if (count > 0) {
      this.persist();
    }
    return count;
  }

  /**
   * Get the latest session for a provider within a run (useful for continuing conversations).
   */
  getLatestForProvider(runId: string, providerId: string): SessionRecord | undefined {
    let latest: SessionRecord | undefined;
    for (const record of this.sessions.values()) {
      if (record.runId === runId && record.providerId === providerId) {
        if (!latest || record.lastUsedAt > latest.lastUsedAt) {
          latest = record;
        }
      }
    }
    return latest;
  }
}
