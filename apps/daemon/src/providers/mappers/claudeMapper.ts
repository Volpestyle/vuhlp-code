import { ProviderOutputEvent, ProviderToolProposal } from "../types.js";
import { randomUUID } from "node:crypto";

/**
 * Claude Code CLI stream-json Event Types
 *
 * Claude Code with --output-format stream-json emits newline-delimited JSON:
 * - init: { type: "init", session_id: string, tools: string[], model: string }
 * - assistant: { type: "assistant", message: { content: string, ... } }
 * - assistant_partial: { type: "assistant_partial", delta: string }
 * - tool_use: { type: "tool_use", id: string, name: string, input: object }
 * - tool_result: { type: "tool_result", tool_use_id: string, content: string, is_error?: boolean }
 * - result: { type: "result", session_id: string, cost: { ... }, duration_ms: number }
 * - error: { type: "error", error: { message: string, ... } }
 */

/**
 * Determines the risk level for a Claude tool.
 */
function toolRiskLevel(name: string, input: Record<string, unknown>): "low" | "medium" | "high" {
  const lowRiskTools = ["Read", "Glob", "Grep", "LSP", "WebSearch", "WebFetch"];
  const highRiskTools = ["Write", "Bash", "Edit"];

  if (lowRiskTools.includes(name)) return "low";
  if (highRiskTools.includes(name)) {
    if (name === "Bash") {
      const command = String(input.command ?? "");
      if (/^(rm|mv|chmod|chown|sudo|dd|mkfs|kill)(\s|$)/i.test(command)) {
        return "high";
      }
    }
    return "medium";
  }
  return "medium";
}

// Track tool use IDs to correlate with results
const pendingTools = new Map<string, { name: string; startTime: number }>();

// Track if we've already emitted message.final for this conversation turn
// to avoid duplicate emissions from both 'assistant' and 'result' events
let emittedFinalContent = false;

/**
 * Maps a raw Claude stream-json event to canonical ProviderOutputEvents.
 */
export function* mapClaudeEvent(raw: unknown): Generator<ProviderOutputEvent> {
  if (!raw || typeof raw !== "object") return;

  const event = raw as Record<string, unknown>;
  const eventType = String(event.type ?? "");

  switch (eventType) {
    case "init": {
      // Reset state for new session
      emittedFinalContent = false;
      const sessionId = event.session_id;
      if (typeof sessionId === "string") {
        yield { type: "session", sessionId };
      }
      break;
    }

    case "assistant_partial": {
      const delta = event.delta;
      if (typeof delta === "string") {
        yield { type: "message.delta", delta, index: typeof event.index === "number" ? event.index : undefined };
      }
      break;
    }

    case "assistant": {
      const message = event.message as Record<string, unknown> | undefined;
      if (message?.content && Array.isArray(message.content)) {
        const textContent = message.content
          .filter((c: Record<string, unknown>) => c.type === "text" && typeof c.text === "string")
          .map((c: Record<string, unknown>) => c.text as string)
          .join("\n");

        if (textContent) {
          yield { type: "message.final", content: textContent };
          emittedFinalContent = true;
        }

        for (const block of message.content as Array<Record<string, unknown>>) {
          if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            const input = (block.input ?? {}) as Record<string, unknown>;
            const tool: ProviderToolProposal = {
              id: block.id,
              name: block.name,
              args: input,
              riskLevel: toolRiskLevel(block.name, input),
            };
            yield { type: "tool.proposed", tool };
            yield { type: "tool.started", toolId: block.id };
            pendingTools.set(block.id, { name: block.name, startTime: Date.now() });
          }
        }
      }
      break;
    }

    case "tool_use": {
      const id = event.id;
      const name = event.name;
      if (typeof id === "string" && typeof name === "string") {
        const input = (event.input ?? {}) as Record<string, unknown>;
        const tool: ProviderToolProposal = {
          id,
          name,
          args: input,
          riskLevel: toolRiskLevel(name, input),
        };
        yield { type: "tool.proposed", tool };
        yield { type: "tool.started", toolId: id };
        pendingTools.set(id, { name, startTime: Date.now() });
      }
      break;
    }

    case "tool_result": {
      const toolUseId = event.tool_use_id;
      if (typeof toolUseId === "string") {
        const pending = pendingTools.get(toolUseId);
        const durationMs = pending ? Date.now() - pending.startTime : undefined;
        pendingTools.delete(toolUseId);

        const content = String(event.content ?? "");
        if (event.is_error) {
          yield { type: "tool.completed", toolId: toolUseId, error: { message: content }, durationMs };
        } else {
          let result: unknown = content;
          try {
            result = JSON.parse(content);
          } catch {
            // Keep as string
          }
          yield { type: "tool.completed", toolId: toolUseId, result, durationMs };
        }
      }
      break;
    }

    case "result": {
      const sessionId = event.session_id;

      // Claude Code sends final text in either 'content' or 'result' field
      const content = typeof event.content === "string" ? event.content : undefined;
      const resultText = typeof event.result === "string" ? event.result : undefined;

      const finalContent = resultText ?? content;

      // Only emit message.final if we haven't already from the 'assistant' event
      // Claude Code sends both 'assistant' (with message content) and 'result' (with same content)
      if (finalContent && !emittedFinalContent) {
        yield { type: "message.final", content: finalContent };
      }
      // Reset for next turn
      emittedFinalContent = false;

      if (typeof sessionId === "string") {
        yield {
          type: "json",
          name: "session_result.json",
          json: {
            session_id: sessionId,
            cost: event.cost,
            duration_ms: event.duration_ms,
            num_turns: event.num_turns,
          },
        };
      }
      break;
    }

    case "error": {
      const error = event.error as Record<string, unknown> | undefined;
      const message = typeof error?.message === "string" ? error.message : "Unknown error";
      yield { type: "progress", message: `[claude] error: ${message}`, raw: error };
      break;
    }

    case "system": {
      const message = event.message;
      if (typeof message === "string") {
        yield { type: "progress", message: `[claude] ${message}` };
      }
      break;
    }
  }
}

/**
 * Check if a raw event is a Claude event.
 */
export function isClaudeEvent(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const event = raw as Record<string, unknown>;
  const type = String(event.type ?? "");
  return ["init", "assistant", "assistant_partial", "tool_use", "tool_result", "result", "error", "system"].includes(type);
}

/**
 * Clear pending tool tracking (call between runs).
 */
export function clearPendingTools(): void {
  pendingTools.clear();
  emittedFinalContent = false;
}
