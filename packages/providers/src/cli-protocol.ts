import type { ApprovalResolution, ToolCall, UUID, ProviderName, UsageTotals } from "@vuhlp/contracts";
import { asJsonObject, getBoolean, getString, parseJsonValue, getNumber } from "./json.js";
import type { JsonObject, JsonValue } from "./json.js";

export type ParsedCliEvent =
  | { type: "message.assistant.delta"; delta: string }
  | { type: "message.assistant.final"; content: string; id?: UUID }
  | { type: "message.assistant.thinking.delta"; delta: string }
  | { type: "message.assistant.thinking.final"; content: string }
  | { type: "tool.proposed"; tool: ToolCall }
  | { type: "tool.started"; tool: ToolCall }
  | { type: "tool.completed"; toolId: UUID; result: { ok: boolean; output?: string | object }; error?: { message: string } }
  | { type: "approval.requested"; approvalId: UUID; tool: ToolCall; context?: string }
  | { type: "approval.resolved"; approvalId: UUID; resolution: ApprovalResolution }
  | {
    type: "telemetry.usage";
    provider: ProviderName;
    model: string;
    usage: UsageTotals;
  };

function isResolutionStatus(value: string): value is ApprovalResolution["status"] {
  return value === "approved" || value === "denied" || value === "modified";
}

export function parseCliEventLine(line: string): ParsedCliEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  const parsed = parseJsonValue(trimmed);
  if (!parsed) {
    return null;
  }

  const obj = asJsonObject(parsed);
  if (!obj) {
    return null;
  }

  return parseCliEventObject(obj);
}

export function parseCliStreamEndLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  const parsed = parseJsonValue(trimmed);
  if (!parsed) {
    return false;
  }
  const obj = asJsonObject(parsed);
  if (!obj) {
    return false;
  }
  const type = getString(obj.type);
  if (type === "stream_event") {
    const eventObj = asJsonObject(obj.event ?? null);
    const eventType = eventObj ? getString(eventObj.type) : null;
    return eventType === "message_stop" || eventType === "message_end";
  }
  return type === "message_stop" || type === "message_end" || type === "result";
}

function parseCliEventObject(obj: JsonObject): ParsedCliEvent | null {
  const type = getString(obj.type);

  // Handle Gemini CLI format: {"parts": [{"thought": true, "text": "..."}, ...]}
  // This format doesn't have a type field
  if (!type && Array.isArray(obj.parts)) {
    return parseGeminiParts(obj.parts);
  }

  if (!type) {
    return null;
  }

  switch (type) {
    // Claude Code CLI stream-json wrapper: {"type":"stream_event","event":{...}}
    case "stream_event": {
      const eventObj = asJsonObject(obj.event ?? null);
      if (!eventObj) return null;
      // Recurse to handle the inner event
      return parseCliEventObject(eventObj);
    }

    // Anthropic Native Events
    case "message_start": {
      // Ignored for now, but valid
      return null;
    }
    case "message_delta": {
      // Ignored for now, but valid
      return null;
    }
    case "message_stop": {
      // Ignored for now, but valid
      return null;
    }
    case "content_block_start": {
      const contentBlock = asJsonObject(obj.content_block ?? null);
      if (!contentBlock) return null;
      const type = getString(contentBlock.type);
      if (type === "text") {
        const text = getString(contentBlock.text);
        return text ? { type: "message.assistant.delta", delta: text } : null;
      }
      if (type === "thinking") {
        const thinking = getString(contentBlock.thinking);
        return thinking ? { type: "message.assistant.thinking.delta", delta: thinking } : null;
      }
      return null;
    }
    case "content_block_delta": {
      const delta = asJsonObject(obj.delta ?? null);
      if (!delta) return null;
      const type = getString(delta.type);
      if (type === "text_delta") {
        const text = getString(delta.text);
        return text ? { type: "message.assistant.delta", delta: text } : null;
      }
      if (type === "thinking_delta") {
        const thinking = getString(delta.thinking);
        return thinking ? { type: "message.assistant.thinking.delta", delta: thinking } : null;
      }
      return null;
    }
    case "content_block_stop": {
      // Ignored for now
      return null;
    }

    // Claude Code CLI stream-json final: {"type":"assistant","message":{"content":[...]} }
    case "assistant": {
      const message = asJsonObject(obj.message ?? null);
      const contentBlocks = message && Array.isArray(message.content) ? message.content : null;
      if (!contentBlocks) {
        return null;
      }
      let text = "";
      for (const block of contentBlocks) {
        const blockObj = asJsonObject(block as JsonValue);
        if (!blockObj) {
          continue;
        }
        if (getString(blockObj.type) !== "text") {
          continue;
        }
        const content = getString(blockObj.text);
        if (content) {
          text += content;
        }
      }
      return text ? { type: "message.assistant.final", content: text } : null;
    }

    case "message.assistant.delta": {
      const delta = getString(obj.delta);
      return delta ? { type, delta } : null;
    }
    case "message.assistant.final": {
      const content = getString(obj.content);
      const id = getString(obj.id);
      return content ? { type, content, ...(id ? { id } : {}) } : null;
    }
    case "message.assistant.thinking.delta": {
      const delta = getString(obj.delta);
      return delta ? { type, delta } : null;
    }
    case "message.assistant.thinking.final": {
      const content = getString(obj.content);
      return content ? { type, content } : null;
    }

    // Gemini CLI stream-json: {"type":"message","role":"assistant","content":"...","delta":true}
    case "message": {
      const role = getString(obj.role);
      const content = getString(obj.content);
      if (role !== "assistant" || !content) {
        return null;
      }
      const delta = getBoolean(obj.delta);
      if (delta === false) {
        return { type: "message.assistant.final", content };
      }
      return { type: "message.assistant.delta", delta: content };
    }

    // Codex CLI: {"type": "item.reasoning", "content": "..."}
    case "item.reasoning": {
      const content = getString(obj.content);
      if (content) {
        return { type: "message.assistant.thinking.delta", delta: content };
      }
      // Also check for text field
      const text = getString(obj.text);
      return text ? { type: "message.assistant.thinking.delta", delta: text } : null;
    }

    // Codex CLI: {"type": "item.message", "content": "..."}
    case "item.message": {
      const content = getString(obj.content);
      if (content) {
        return { type: "message.assistant.delta", delta: content };
      }
      const text = getString(obj.text);
      return text ? { type: "message.assistant.delta", delta: text } : null;
    }

    // Claude Code CLI: {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "..."}}
    case "content_block_delta": {
      const delta = asJsonObject(obj.delta);
      if (!delta) {
        return null;
      }
      const deltaType = getString(delta.type);
      if (deltaType === "thinking_delta") {
        const thinking = getString(delta.thinking);
        return thinking ? { type: "message.assistant.thinking.delta", delta: thinking } : null;
      }
      if (deltaType === "text_delta") {
        const text = getString(delta.text);
        return text ? { type: "message.assistant.delta", delta: text } : null;
      }
      return null;
    }

    // Claude Code CLI: {"type": "content_block_start", "content_block": {"type": "thinking", ...}}
    case "content_block_start": {
      const contentBlock = asJsonObject(obj.content_block);
      if (!contentBlock) {
        return null;
      }
      const blockType = getString(contentBlock.type);
      if (blockType === "thinking") {
        const thinking = getString(contentBlock.thinking);
        return thinking ? { type: "message.assistant.thinking.delta", delta: thinking } : null;
      }
      if (blockType === "text") {
        const text = getString(contentBlock.text);
        return text ? { type: "message.assistant.delta", delta: text } : null;
      }
      return null;
    }

    // Gemini CLI stream-json: {"type":"tool_use","tool_name":"...","tool_id":"...","parameters":{...}}
    case "tool_use": {
      const name = getString(obj.tool_name);
      const id = getString(obj.tool_id);
      const parameters = asJsonObject(obj.parameters ?? null);
      if (!name || !id || !parameters) {
        return null;
      }
      return {
        type: "tool.proposed",
        tool: {
          id,
          name,
          args: parameters
        }
      };
    }

    // Gemini CLI stream-json: {"type":"tool_result","tool_id":"...","status":"success","output":"..."}
    case "tool_result": {
      const toolId = getString(obj.tool_id);
      const status = getString(obj.status);
      if (!toolId || (status !== "success" && status !== "error")) {
        return null;
      }
      const result: { ok: boolean; output?: string | object } = { ok: status === "success" };
      const output = obj.output;
      if (output !== undefined && output !== null && typeof output !== "number" && typeof output !== "boolean") {
        result.output = output;
      }
      const errorObj = asJsonObject(obj.error ?? null);
      const errorMessage = errorObj ? getString(errorObj.message) : null;
      const error = errorMessage ? { message: errorMessage } : undefined;
      return error ? { type: "tool.completed", toolId, result, error } : { type: "tool.completed", toolId, result };
    }

    case "tool.proposed":
    case "tool.started": {
      const tool = parseToolCall(obj.tool);
      return tool ? { type, tool } : null;
    }
    case "tool.completed": {
      const toolId = getString(obj.toolId);
      const result = parseToolResult(obj.result);
      const error = parseErrorObject(obj.error);
      if (!toolId || !result) {
        return null;
      }
      return error ? { type, toolId, result, error } : { type, toolId, result };
    }
    case "approval.requested": {
      const approvalId = getString(obj.approvalId);
      const tool = parseToolCall(obj.tool);
      const context = getString(obj.context);
      if (!approvalId || !tool) {
        return null;
      }
      return context ? { type, approvalId, tool, context } : { type, approvalId, tool };
    }
    case "approval.resolved": {
      const approvalId = getString(obj.approvalId);
      const resolution = parseApprovalResolution(obj.resolution);
      if (!approvalId || !resolution) {
        return null;
      }
      return { type, approvalId, resolution };
    }
    case "telemetry.usage": {
      const provider = getString(obj.provider) as ProviderName;
      const model = getString(obj.model);
      const usage = parseUsage(obj.usage);
      if (!provider || !model || !usage) {
        return null;
      }
      return { type, provider, model, usage };
    }
    default:
      return null;
  }
}

/**
 * Parse Gemini CLI format: {"parts": [{"thought": true, "text": "..."}, {"thought": false, "text": "..."}]}
 * Returns thinking delta for thought parts, or message delta for non-thought parts
 */
function parseGeminiParts(parts: unknown[]): ParsedCliEvent | null {
  // Collect thinking and message content separately
  let thinkingContent = "";
  let messageContent = "";

  for (const part of parts) {
    const partObj = asJsonObject(part as JsonValue);
    if (!partObj) {
      continue;
    }
    const text = getString(partObj.text);
    if (!text) {
      continue;
    }
    const isThought = partObj.thought === true;
    if (isThought) {
      thinkingContent += text;
    } else {
      messageContent += text;
    }
  }

  // Prioritize thinking content if present
  if (thinkingContent) {
    return { type: "message.assistant.thinking.delta", delta: thinkingContent };
  }
  if (messageContent) {
    return { type: "message.assistant.delta", delta: messageContent };
  }
  return null;
}

function parseToolCall(value: JsonValue): ToolCall | null {
  const obj = asJsonObject(value);
  if (!obj) {
    return null;
  }
  const id = getString(obj.id);
  const name = getString(obj.name);
  const args = asJsonObject(obj.args ?? null);
  if (!id || !name || !args) {
    return null;
  }
  return { id, name, args };
}

function parseToolResult(value: JsonValue): { ok: boolean; output?: string | object } | null {
  const obj = asJsonObject(value);
  if (!obj) {
    return null;
  }
  const ok = getBoolean(obj.ok);
  if (ok === null) {
    return null;
  }
  const output = obj.output;
  if (output !== undefined && output !== null && typeof output !== "number" && typeof output !== "boolean") {
    return { ok, output };
  }
  return { ok };
}

function parseErrorObject(value: JsonValue): { message: string } | undefined {
  const obj = asJsonObject(value);
  if (!obj) {
    return undefined;
  }
  const message = getString(obj.message);
  return message ? { message } : undefined;
}

function parseApprovalResolution(value: JsonValue): ApprovalResolution | null {
  const obj = asJsonObject(value);
  if (!obj) {
    return null;
  }
  const status = getString(obj.status);
  if (!status || !isResolutionStatus(status)) {
    return null;
  }
  const modifiedArgs = asJsonObject(obj.modifiedArgs ?? null);
  if (modifiedArgs && status !== "modified") {
    return null;
  }
  if (modifiedArgs && status === "modified") {
    return { status, modifiedArgs };
  }
  return { status };
}

function parseUsage(
  value: JsonValue
): UsageTotals | null {
  const obj = asJsonObject(value);
  if (!obj) {
    return null;
  }
  const promptTokens = getNumber(obj.promptTokens);
  const completionTokens = getNumber(obj.completionTokens);
  const totalTokens = getNumber(obj.totalTokens);

  if (promptTokens === null || completionTokens === null || totalTokens === null) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens };
}
