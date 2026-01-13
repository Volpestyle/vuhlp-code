import { randomUUID } from "node:crypto";
import { EventBus } from "./eventBus.js";
import { PendingPrompt, ContextPack } from "./types.js";
import { nowIso } from "./time.js";

/**
 * PromptQueue - Manages pending prompts for the orchestrator (section 3.4).
 *
 * In INTERACTIVE mode, orchestrator-intended prompts are queued here instead of
 * being sent immediately. Users can review, modify, send, or cancel these prompts.
 */
export class PromptQueue {
  private prompts: Map<string, PendingPrompt> = new Map();
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  /**
   * Add an orchestrator-generated prompt to the queue.
   * Called when the orchestrator wants to send a prompt but is in INTERACTIVE mode.
   */
  addOrchestratorPrompt(params: {
    runId: string;
    targetNodeId: string;
    content: string;
    contextPack?: ContextPack;
  }): PendingPrompt {
    const prompt: PendingPrompt = {
      id: randomUUID(),
      runId: params.runId,
      targetNodeId: params.targetNodeId,
      source: "orchestrator",
      content: params.content,
      contextPack: params.contextPack,
      createdAt: nowIso(),
      status: "pending",
    };

    this.prompts.set(prompt.id, prompt);
    this.bus.emitPromptQueued(params.runId, prompt);
    return prompt;
  }

  /**
   * Add a user-written prompt to the queue.
   * Used when user types a prompt but wants to review before sending.
   */
  addUserPrompt(params: {
    runId: string;
    targetNodeId?: string;
    content: string;
  }): PendingPrompt {
    const prompt: PendingPrompt = {
      id: randomUUID(),
      runId: params.runId,
      targetNodeId: params.targetNodeId,
      source: "user",
      content: params.content,
      createdAt: nowIso(),
      status: "pending",
    };

    this.prompts.set(prompt.id, prompt);
    this.bus.emitPromptQueued(params.runId, prompt);
    return prompt;
  }

  /**
   * Get all pending prompts for a run.
   */
  getPendingForRun(runId: string): PendingPrompt[] {
    return Array.from(this.prompts.values())
      .filter((p) => p.runId === runId && p.status === "pending")
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /**
   * Get all orchestrator-generated prompts that are pending.
   */
  getOrchestratorPending(runId: string): PendingPrompt[] {
    return this.getPendingForRun(runId).filter((p) => p.source === "orchestrator");
  }

  /**
   * Get all user-written prompts that are pending.
   */
  getUserPending(runId: string): PendingPrompt[] {
    return this.getPendingForRun(runId).filter((p) => p.source === "user");
  }

  /**
   * Get a specific prompt by ID.
   */
  getPrompt(promptId: string): PendingPrompt | undefined {
    return this.prompts.get(promptId);
  }

  /**
   * Mark a prompt as sent.
   * Called when the prompt is actually dispatched to the agent.
   */
  markSent(promptId: string): boolean {
    const prompt = this.prompts.get(promptId);
    if (!prompt || prompt.status !== "pending") return false;

    prompt.status = "sent";
    this.bus.emitPromptSent(prompt.runId, promptId, prompt.targetNodeId);
    return true;
  }

  /**
   * Cancel a pending prompt.
   */
  cancel(promptId: string, reason?: string): boolean {
    const prompt = this.prompts.get(promptId);
    if (!prompt || prompt.status !== "pending") return false;

    prompt.status = "cancelled";
    this.bus.emitPromptCancelled(prompt.runId, promptId, reason);
    return true;
  }

  /**
   * Modify a pending prompt's content.
   */
  modifyContent(promptId: string, newContent: string): boolean {
    const prompt = this.prompts.get(promptId);
    if (!prompt || prompt.status !== "pending") return false;

    prompt.content = newContent;
    // Re-emit as queued to update UI
    this.bus.emitPromptQueued(prompt.runId, prompt);
    return true;
  }

  /**
   * Clear all prompts for a run (e.g., when run completes or is stopped).
   */
  clearRun(runId: string): void {
    for (const [id, prompt] of this.prompts.entries()) {
      if (prompt.runId === runId) {
        if (prompt.status === "pending") {
          prompt.status = "cancelled";
          this.bus.emitPromptCancelled(prompt.runId, id, "run_cleared");
        }
        this.prompts.delete(id);
      }
    }
  }

  /**
   * Get count of pending prompts for a run.
   */
  getPendingCount(runId: string): number {
    return this.getPendingForRun(runId).length;
  }

  /**
   * Check if there are any pending orchestrator prompts.
   * Used to show indicator in UI when orchestrator has work queued.
   */
  hasOrchestratorPending(runId: string): boolean {
    return this.getOrchestratorPending(runId).length > 0;
  }
}
