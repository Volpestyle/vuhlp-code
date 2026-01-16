import { ProviderOutputEvent, ProviderToolProposal } from "../types.js";
import { randomUUID } from "node:crypto";

/**
 * Gemini CLI stream-json Event Types
 *
 * Gemini CLI with --output-format stream-json emits newline-delimited JSON:
 * - init: { type: "init", session_id: string, model: string }
 * - message: { type: "message", role: "model" | "user", content: string, parts?: [...] }
 * - tool_use: { type: "tool_use", id: string, name: string, args: object }
 * - tool_result: { type: "tool_result", id: string, output: string, error?: string }
 * - result: { type: "result", session_id: string, token_stats?: {...}, reasoning_summary?: string }
 * - error: { type: "error", message: string, code?: string }
 */

/**
 * Determines the risk level for a Gemini tool.
 */
function toolRiskLevel(name: string, args: Record<string, unknown>): "low" | "medium" | "high" {
  const lowRiskTools = ["read_file", "list_files", "search_files", "web_search"];
  const highRiskTools = ["write_file", "execute_command", "delete_file"];

  const lowerName = name.toLowerCase();

  if (lowRiskTools.some((t) => lowerName.includes(t))) return "low";

  if (highRiskTools.some((t) => lowerName.includes(t))) {
    if (lowerName.includes("execute_command")) {
      const command = String(args.command ?? "");
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

/**
 * Maps a raw Gemini stream-json event to canonical ProviderOutputEvents.
 */
export function* mapGeminiEvent(raw: unknown): Generator<ProviderOutputEvent> {
  if (!raw || typeof raw !== "object") return;

  const event = raw as Record<string, unknown>;
  const eventType = String(event.type ?? "");

  switch (eventType) {
    case "init": {
      const sessionId = event.session_id;
      if (typeof sessionId === "string") {
        yield { type: "session", sessionId };
      }
      break;
    }

    case "delta": {
      const content = event.content;
      if (typeof content === "string") {
        yield { type: "message.delta", delta: content, index: typeof event.index === "number" ? event.index : undefined };
      }
      break;
    }

    case "thinking": {
      const content = event.content;
      if (typeof content === "string") {
        yield { type: "message.reasoning", content };
      }
      break;
    }

    case "message": {
      const role = String(event.role);
      const isDelta = !!event.delta;

      if (role === "model" || role === "assistant") {
        let textContent = typeof event.content === "string" ? event.content : "";

        const parts = event.parts as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part.type === "text" && typeof part.text === "string") {
              textContent += part.text;
            }
            if (part.type === "code" && typeof part.code === "string") {
              const language = typeof part.language === "string" ? part.language : "";
              textContent += `\n\`\`\`${language}\n${part.code}\n\`\`\`\n`;
            }
            if (part.type === "execution_result" && typeof part.output === "string") {
              yield {
                type: "json",
                name: "execution_result.json",
                json: { output: part.output },
              };
            }
          }
        }

        if (textContent) {
          if (isDelta) {
            yield { type: "message.delta", delta: textContent };
          } else {
            yield { type: "message.final", content: textContent };
          }
        }
      }
      break;
    }

    case "tool_use": {
      // Support both old (id/name/args) and new (tool_id/tool_name/parameters) formats
      const id = (event.id ?? event.tool_id) as string;
      const name = (event.name ?? event.tool_name) as string;

      if (typeof id === "string" && typeof name === "string") {
        const args = (event.args ?? event.parameters ?? {}) as Record<string, unknown>;
        const tool: ProviderToolProposal = {
          id,
          name,
          args,
          riskLevel: toolRiskLevel(name, args),
        };
        yield { type: "tool.proposed", tool };
        yield { type: "tool.started", toolId: id };
        pendingTools.set(id, { name, startTime: Date.now() });
      }
      break;
    }

    case "tool_result": {
      const id = (event.id ?? event.tool_id) as string;
      if (typeof id === "string") {
        const pending = pendingTools.get(id);
        const durationMs = pending ? Date.now() - pending.startTime : undefined;
        pendingTools.delete(id);

        const error = event.error;
        if (typeof error === "string") {
          yield { type: "tool.completed", toolId: id, error: { message: error }, durationMs };
        } else if (error && typeof error === "object") {
          // Handle structured error object
          const errMsg = (error as any).message ?? JSON.stringify(error);
          yield { type: "tool.completed", toolId: id, error: { message: errMsg }, durationMs };
        } else {
          const output = event.output;
          let result: unknown = output;
          if (typeof output === "string") {
            try {
              result = JSON.parse(output);
            } catch {
              // Keep as string
            }
          }
          yield { type: "tool.completed", toolId: id, result, durationMs };
        }
      }
      break;
    }

    case "result": {
      const sessionId = event.session_id;
      const reasoningSummary = event.reasoning_summary;

      if (typeof reasoningSummary === "string") {
        yield { type: "message.reasoning", content: reasoningSummary };
      }

      if (typeof sessionId === "string") {
        yield {
          type: "json",
          name: "session_result.json",
          json: {
            session_id: sessionId,
            token_stats: event.token_stats,
            duration_ms: event.duration_ms,
          },
        };
      }
      break;
    }

    case "error": {
      const message = typeof event.message === "string" ? event.message : "Unknown error";
      yield {
        type: "progress",
        message: `[gemini] error: ${message}`,
        raw: { message, code: event.code },
      };
      break;
    }
  }
}

/**
 * Check if a raw event is a Gemini event.
 */
export function isGeminiEvent(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const event = raw as Record<string, unknown>;
  const type = String(event.type ?? "");
  return ["init", "message", "tool_use", "tool_result", "result", "error", "thinking", "delta"].includes(type);
}

/**
 * Clear pending tool tracking (call between runs).
 */
export function clearPendingTools(): void {
  pendingTools.clear();
}
