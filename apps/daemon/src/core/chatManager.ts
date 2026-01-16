import { randomUUID } from "node:crypto";
import { EventBus } from "./eventBus.js";
import { ChatMessageRecord, InteractionMode } from "./types.js";
import { nowIso } from "./time.js";

export interface ChatManagerConfig {
  maxQueuedMessages?: number;
}

export interface SendMessageParams {
  runId: string;
  nodeId?: string;
  content: string;
  interrupt?: boolean;
}

export interface SendMessageResult {
  message: ChatMessageRecord;
  shouldInterrupt: boolean;
}

export class ChatManager {
  private bus: EventBus;
  private store: import("./store.js").RunStore;
  private interactionModes: Map<string, InteractionMode> = new Map(); // "runId" or "runId:nodeId" -> mode
  private config: Required<ChatManagerConfig>;

  constructor(bus: EventBus, store: import("./store.js").RunStore, config?: ChatManagerConfig) {
    this.bus = bus;
    this.store = store;
    this.config = {
      maxQueuedMessages: config?.maxQueuedMessages ?? 50,
    };
  }

  /**
   * Send a chat message, optionally triggering an interrupt.
   * Returns the message record and whether an interrupt should occur.
   */
  sendMessage(params: SendMessageParams): SendMessageResult {
    const { runId, nodeId, content, interrupt = true } = params;

    const message: ChatMessageRecord = {
      id: randomUUID(),
      runId,
      nodeId,
      role: "user",
      content,
      createdAt: nowIso(),
      processed: false,
      interruptedExecution: interrupt,
    };

    this.store.addChatMessage(runId, message);

    if (interrupt) {
      this.bus.emitChatMessageSent(runId, message, true);
    } else {
      this.bus.emitChatMessageQueued(runId, message);
    }

    // Also emit message.user event so it appears in the node's terminal immediately
    // Use the target nodeId, or fall back to root orchestrator if not specified
    const run = this.store.getRun(runId);
    const targetNodeId = nodeId || run?.rootOrchestratorNodeId;
    if (targetNodeId) {
      this.bus.emitMessageUser(runId, targetNodeId, content);
    }

    return { message, shouldInterrupt: interrupt };
  }

  /**
   * Queue a message for the next iteration without interrupting.
   */
  queueMessage(runId: string, content: string, nodeId?: string): ChatMessageRecord {
    const result = this.sendMessage({
      runId,
      nodeId,
      content,
      interrupt: false,
    });
    return result.message;
  }

  /**
   * Get all pending (unprocessed) messages for a run or specific node.
   */
  getPendingMessages(runId: string, nodeId?: string): ChatMessageRecord[] {
    const run = this.store.getRun(runId);
    if (!run) return [];

    // Safety check if property missing on old runs
    const allMessages = run.chatMessages || [];

    return allMessages.filter((msg) => {
      if (msg.processed) return false;
      if (nodeId !== undefined) {
        // If nodeId is specified, only get messages for that node
        // Also include run-level messages (nodeId undefined)
        return msg.nodeId === nodeId || msg.nodeId === undefined;
      }
      return true;
    });
  }

  /**
   * Mark messages as processed after they've been sent to the agent.
   * Returns the number of messages actually marked (excludes already-processed).
   */
  markProcessed(runId: string, messageIds: string[]): number {
    const run = this.store.getRun(runId);
    if (!run || !run.chatMessages) return 0;

    const idSet = new Set(messageIds);
    let markedCount = 0;

    for (const msg of run.chatMessages) {
      if (idSet.has(msg.id) && !msg.processed) {
        msg.processed = true;
        markedCount++;
      }
    }

    if (markedCount > 0) {
      run.updatedAt = nowIso();
      this.store.persistRun(run);
    }

    return markedCount;
  }

  /**
   * Get the interaction mode for a run or specific node.
   * Defaults to "autonomous" if not set.
   */
  getInteractionMode(runId: string, nodeId?: string): InteractionMode {
    const key = nodeId ? `${runId}:${nodeId}` : runId;
    return this.interactionModes.get(key) ?? "autonomous";
  }

  /**
   * Set the interaction mode for a run or specific node.
   */
  setInteractionMode(runId: string, nodeId: string | undefined, mode: InteractionMode): void {
    const key = nodeId ? `${runId}:${nodeId}` : runId;
    const previousMode = this.getInteractionMode(runId, nodeId);

    if (previousMode !== mode) {
      this.interactionModes.set(key, mode);
      this.bus.emitInteractionModeChanged(runId, nodeId, mode, previousMode);
    }
  }

  /**
   * Get all messages for a run, optionally filtered by node.
   */
  getMessages(runId: string, nodeId?: string): ChatMessageRecord[] {
    const run = this.store.getRun(runId);
    if (!run) return [];

    const allMessages = run.chatMessages || [];

    if (nodeId !== undefined) {
      return allMessages.filter(
        (msg) => msg.nodeId === nodeId || msg.nodeId === undefined
      );
    }
    return [...allMessages];
  }

  /**
   * Clear all messages for a run (e.g., when run completes).
   */
  clearMessages(runId: string): void {
    // No-op for now? Or actually delete?
    // If we want persistence, we probably shouldn't clear them unless explicitly asked.
    // But index.ts calls this on deleteRun.
    // Since they are part of the run record now, they get deleted when the run is deleted via store.deleteRun.
    // proper logic: do nothing, store handles it.
  }

  /**
   * Clear interaction modes for a run.
   */
  clearModes(runId: string): void {
    // Remove all keys that start with this runId
    for (const key of this.interactionModes.keys()) {
      if (key === runId || key.startsWith(`${runId}:`)) {
        this.interactionModes.delete(key);
      }
    }
  }

  /**
   * Format a list of chat messages for prompt injection.
   */
  formatChatMessages(messages: ChatMessageRecord[]): string {
    if (messages.length === 0) return "";

    const lines = messages.map((msg) => {
      const scope = msg.nodeId ? `[node:${msg.nodeId}]` : "[run]";
      return `${scope} [${msg.createdAt}]: ${msg.content}`;
    });

    return `\n\n--- USER CHAT MESSAGES ---\n${lines.join("\n")}\n--- END CHAT MESSAGES ---`;
  }

  /**
   * Atomically consume pending messages based on a selector function.
   * Only messages that return true from the selector are marked processed and returned.
   */
  consumeMessages(runId: string, selector: (msg: ChatMessageRecord) => boolean, dryRun = false): { formatted: string; messages: ChatMessageRecord[] } {
    const allPending = this.getPendingMessages(runId);
    if (allPending.length === 0) {
      return { formatted: "", messages: [] };
    }

    const selectedMessages = allPending.filter(selector);
    if (selectedMessages.length === 0) {
      return { formatted: "", messages: [] };
    }

    if (!dryRun) {
      this.markProcessed(runId, selectedMessages.map((m) => m.id));
    }

    return {
      formatted: this.formatChatMessages(selectedMessages),
      messages: selectedMessages,
    };
  }

  /**
   * Atomically consume and format pending messages.
   * Gets pending messages, marks them as processed, and returns formatted string.
   */
  consumeAndFormatMessages(runId: string, nodeId?: string): { formatted: string; messageIds: string[] } {
    const result = this.consumeMessages(runId, (msg) => {
      if (nodeId !== undefined) {
        return msg.nodeId === nodeId || msg.nodeId === undefined;
      }
      return true;
    });

    return {
      formatted: result.formatted,
      messageIds: result.messages.map(m => m.id),
    };
  }
}
