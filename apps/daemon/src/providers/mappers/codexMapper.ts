import { ProviderOutputEvent, ProviderToolProposal } from "../types.js";
import { randomUUID } from "node:crypto";

/**
 * Codex CLI JSONL Event Types
 *
 * Codex emits newline-delimited JSON events with these structures:
 * - thread.started: { type: "thread.started", thread_id: string }
 * - turn.started: { type: "turn.started", turn_id: string }
 * - turn.completed: { type: "turn.completed", turn_id: string }
 * - item: { type: "item", item: CodexItem }
 *
 * CodexItem types:
 * - message: { type: "message", role: "assistant", content: string }
 * - reasoning: { type: "reasoning", content: string }
 * - command_execution: { type: "command_execution", command: string, output: string, exit_code: number }
 * - file_change: { type: "file_change", path: string, diff: string }
 * - mcp_tool_call: { type: "mcp_tool_call", tool: string, args: object, result: any }
 * - web_search: { type: "web_search", query: string, results: array }
 */

/**
 * Determines the risk level for a command execution.
 */
function commandRiskLevel(command: string): "low" | "medium" | "high" {
  const lowRisk = /^(ls|cat|head|tail|grep|find|pwd|echo|which|type|file|stat|wc|diff)(\s|$)/i;
  const highRisk = /^(rm|mv|chmod|chown|sudo|dd|mkfs|kill|pkill|shutdown|reboot)(\s|$)/i;

  if (highRisk.test(command)) return "high";
  if (lowRisk.test(command)) return "low";
  return "medium";
}

/**
 * Maps a raw Codex JSONL event to canonical ProviderOutputEvents.
 */
export function* mapCodexEvent(raw: unknown): Generator<ProviderOutputEvent> {
  if (!raw || typeof raw !== "object") return;

  const event = raw as Record<string, unknown>;
  const eventType = String(event.type ?? "");

  switch (eventType) {
    case "thread.started": {
      const threadId = event.thread_id;
      if (typeof threadId === "string") {
        yield { type: "session", sessionId: threadId };
      }
      break;
    }

    case "turn.started":
    case "turn.completed":
      // Turn lifecycle is mostly internal
      break;

    case "item": {
      const item = event.item as Record<string, unknown> | undefined;
      if (!item || typeof item !== "object") break;

      const itemType = String(item.type ?? "");

      switch (itemType) {
        case "message": {
          const role = item.role;
          const content = item.content;
          if (role === "assistant" && typeof content === "string") {
            yield { type: "message.final", content };
          }
          break;
        }

        case "reasoning": {
          const content = item.content;
          if (typeof content === "string") {
            yield { type: "message.reasoning", content };
          }
          break;
        }

        case "command_execution": {
          const command = String(item.command ?? "");
          const toolId = randomUUID();
          const status = item.status;

          if (status === "running" || !status) {
            const tool: ProviderToolProposal = {
              id: toolId,
              name: "command_execution",
              args: { command },
              riskLevel: commandRiskLevel(command),
            };
            yield { type: "tool.proposed", tool };
            yield { type: "tool.started", toolId };
          }

          if (status === "completed" || item.exit_code !== undefined) {
            yield {
              type: "tool.completed",
              toolId,
              result: { output: item.output, exit_code: item.exit_code },
            };
          }

          if (status === "failed") {
            yield {
              type: "tool.completed",
              toolId,
              error: { message: `Command failed: ${command}` },
            };
          }
          break;
        }

        case "file_change": {
          const path = String(item.path ?? "unknown");
          const diff = item.diff;
          if (typeof diff === "string") {
            yield { type: "diff", name: `${path}.patch`, patch: diff };
          }
          break;
        }

        case "mcp_tool_call": {
          const toolName = String(item.tool ?? "unknown");
          const toolId = randomUUID();
          const args = (item.args ?? {}) as Record<string, unknown>;
          const status = item.status;

          const tool: ProviderToolProposal = {
            id: toolId,
            name: toolName,
            args,
            riskLevel: "medium",
          };
          yield { type: "tool.proposed", tool };

          if (status === "running" || !status) {
            yield { type: "tool.started", toolId };
          }

          if (status === "completed" || item.result !== undefined) {
            yield { type: "tool.completed", toolId, result: item.result };
          }

          if (status === "failed") {
            yield { type: "tool.completed", toolId, error: { message: `MCP tool failed: ${toolName}` } };
          }
          break;
        }

        case "web_search": {
          const query = String(item.query ?? "");
          yield {
            type: "json",
            name: "web_search_results.json",
            json: { query, results: item.results },
          };
          break;
        }
      }
      break;
    }
  }
}

/**
 * Check if a raw event is a Codex event.
 */
export function isCodexEvent(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const event = raw as Record<string, unknown>;
  const type = String(event.type ?? "");
  return ["thread.started", "turn.started", "turn.completed", "item"].includes(type);
}
