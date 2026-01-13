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
  private messages: Map<string, ChatMessageRecord[]> = new Map(); // runId -> messages
  private interactionModes: Map<string, InteractionMode> = new Map(); // "runId" or "runId:nodeId" -> mode
  private config: Required<ChatManagerConfig>;

  constructor(bus: EventBus, config?: ChatManagerConfig) {
    this.bus = bus;
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

    this.storeMessage(runId, message);

    if (interrupt) {
      this.bus.emitChatMessageSent(runId, message, true);
    } else {
      this.bus.emitChatMessageQueued(runId, message);
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
    const allMessages = this.messages.get(runId) ?? [];
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
   */
  markProcessed(messageIds: string[]): void {
    const idSet = new Set(messageIds);
    for (const messages of this.messages.values()) {
      for (const msg of messages) {
        if (idSet.has(msg.id)) {
          msg.processed = true;
        }
      }
    }
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
    const allMessages = this.messages.get(runId) ?? [];
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
    this.messages.delete(runId);
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
   * Build a prompt section containing pending chat messages.
   * Returns empty string if no pending messages.
   */
  buildChatPromptSection(runId: string, nodeId?: string): string {
    const pending = this.getPendingMessages(runId, nodeId);
    if (pending.length === 0) return "";

    const lines = pending.map((msg) => {
      const scope = msg.nodeId ? `[node:${msg.nodeId}]` : "[run]";
      return `${scope} [${msg.createdAt}]: ${msg.content}`;
    });

    return `\n\n--- USER CHAT MESSAGES ---\n${lines.join("\n")}\n--- END CHAT MESSAGES ---`;
  }

  private storeMessage(runId: string, message: ChatMessageRecord): void {
    let messages = this.messages.get(runId);
    if (!messages) {
      messages = [];
      this.messages.set(runId, messages);
    }

    messages.push(message);

    // Trim old messages if exceeding max
    if (messages.length > this.config.maxQueuedMessages) {
      const toRemove = messages.length - this.config.maxQueuedMessages;
      messages.splice(0, toRemove);
    }
  }
}
