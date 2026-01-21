import type { UserMessageRecord, UUID } from "@vuhlp/contracts";
import type { Logger, LogMeta, ProviderConfig } from "@vuhlp/providers";
import { newId, nowIso } from "./utils.js";

export type PromptKind = "full" | "delta";

export interface ReplayableInput {
  messages: UserMessageRecord[];
}

export interface SessionStateManagerOptions {
  runId: UUID;
  nodeId: UUID;
  baseArgs: string[];
  resumeArgs: string[];
  replayTurns: number;
  statelessProtocol: boolean;
  logger?: Logger;
  logMeta?: LogMeta;
}

export class SessionStateManager {
  private promptSent = false;
  private lastPromptHeaderHash?: string;
  private needsReplay = false;
  private transcript: UserMessageRecord[] = [];
  private completedTurns = 0;
  private readonly baseArgs: string[];
  private readonly resumeArgs: string[];
  private readonly replayTurns: number;
  private readonly statelessProtocol: boolean;
  private readonly runId: UUID;
  private readonly nodeId: UUID;
  private readonly logger?: Logger;
  private readonly logMeta: LogMeta;

  constructor(options: SessionStateManagerOptions) {
    this.baseArgs = [...options.baseArgs];
    this.resumeArgs = [...options.resumeArgs];
    this.replayTurns = Math.max(0, options.replayTurns);
    this.statelessProtocol = options.statelessProtocol;
    this.runId = options.runId;
    this.nodeId = options.nodeId;
    this.logger = options.logger;
    this.logMeta = options.logMeta ?? { runId: options.runId, nodeId: options.nodeId };
  }

  getReplayTurns(): number {
    return this.replayTurns;
  }

  isStatelessProtocol(): boolean {
    return this.statelessProtocol;
  }

  resolvePromptKind(resumeEnabled: boolean, promptHeaderHash: string): PromptKind {
    if (this.needsReplay) {
      this.logDebug("prompt kind resolved", { promptKind: "full", reason: "needs-replay" });
      return "full";
    }
    if (!resumeEnabled) {
      this.logDebug("prompt kind resolved", { promptKind: "full", reason: "resume-disabled" });
      return "full";
    }
    if (!this.promptSent) {
      this.logDebug("prompt kind resolved", { promptKind: "full", reason: "prompt-not-sent" });
      return "full";
    }
    if (this.lastPromptHeaderHash !== promptHeaderHash) {
      this.logDebug("prompt kind resolved", { promptKind: "full", reason: "prompt-header-changed" });
      return "full";
    }
    this.logDebug("prompt kind resolved", { promptKind: "delta", reason: "header-match" });
    return "delta";
  }

  notePromptSent(promptKind: PromptKind, promptHeaderHash: string): void {
    this.promptSent = true;
    if (promptKind === "full") {
      this.lastPromptHeaderHash = promptHeaderHash;
    }
  }

  clearReplayFlag(): boolean {
    if (!this.needsReplay) {
      return false;
    }
    this.needsReplay = false;
    return true;
  }

  markDisconnected(): boolean {
    this.promptSent = false;
    this.lastPromptHeaderHash = undefined;
    const canReplay = this.canReplay();
    this.needsReplay = canReplay;
    this.logDebug("session prompt invalidated", { canReplay, replayTurns: this.replayTurns });
    return canReplay;
  }

  resetForSessionReset(): void {
    this.promptSent = false;
    this.lastPromptHeaderHash = undefined;
    this.completedTurns = 0;
    this.needsReplay = false;
    this.transcript = [];
    this.logDebug("session state reset");
  }

  markTurnCompleted(): void {
    this.completedTurns += 1;
    this.logDebug("turn completed", { completedTurns: this.completedTurns });
  }

  applyResumeArgs(config: ProviderConfig): void {
    if (config.transport !== "cli") {
      return;
    }
    const shouldResume = config.resume && this.completedTurns > 0 && this.resumeArgs.length > 0;
    config.args = shouldResume ? [...this.baseArgs, ...this.resumeArgs] : [...this.baseArgs];
    this.logDebug("resume args applied", {
      shouldResume,
      completedTurns: this.completedTurns,
      baseArgs: this.baseArgs.length,
      resumeArgs: this.resumeArgs.length
    });
  }

  injectReplayMessages<T extends ReplayableInput>(
    input: T
  ): { input: T; replayed: boolean } {
    if (!this.shouldReplay()) {
      return { input, replayed: false };
    }
    const history = this.getReplayMessages();
    if (history.length === 0) {
      return { input, replayed: false };
    }
    const nextInput = {
      ...input,
      messages: [...history, ...input.messages]
    };
    this.logDebug("replay history injected", { replayCount: history.length });
    return {
      input: nextInput,
      replayed: true
    };
  }

  recordTranscript(incoming: UserMessageRecord[], assistantMessage?: string): void {
    if (this.replayTurns <= 0) {
      return;
    }
    const content = assistantMessage?.trim();
    const addedMessages = incoming.length + (content ? 1 : 0);
    this.transcript.push(...incoming);
    if (content) {
      this.transcript.push({
        id: newId(),
        runId: this.runId,
        nodeId: this.nodeId,
        role: "assistant",
        content,
        createdAt: nowIso()
      });
    }
    const maxMessages = this.replayTurns * 2;
    let trimmed = 0;
    if (maxMessages > 0 && this.transcript.length > maxMessages) {
      trimmed = this.transcript.length - maxMessages;
      this.transcript = this.transcript.slice(-maxMessages);
    }
    this.logDebug("transcript updated", {
      addedMessages,
      totalMessages: this.transcript.length,
      trimmed,
      maxMessages
    });
  }

  private shouldReplay(): boolean {
    if (this.replayTurns <= 0) {
      return false;
    }
    if (this.needsReplay) {
      return true;
    }
    return this.statelessProtocol && this.resumeArgs.length === 0;
  }

  private getReplayMessages(): UserMessageRecord[] {
    const maxMessages = this.replayTurns * 2;
    if (maxMessages <= 0 || this.transcript.length === 0) {
      return [];
    }
    return this.transcript.slice(-maxMessages);
  }

  private canReplay(): boolean {
    return this.resumeArgs.length === 0 && this.replayTurns > 0;
  }

  private logDebug(message: string, meta?: LogMeta): void {
    if (!this.logger) {
      return;
    }
    this.logger.debug(message, { ...this.logMeta, ...meta });
  }
}
