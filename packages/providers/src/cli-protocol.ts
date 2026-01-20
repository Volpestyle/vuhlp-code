import type { ApprovalResolution, ToolCall, UUID, ProviderName, UsageTotals } from "@vuhlp/contracts";
import { asJsonObject, getBoolean, getString, parseJsonValue, getNumber } from "./json.js";
import type { JsonObject, JsonValue } from "./json.js";

export type ParsedCliEvent =
  | { type: "message.assistant.delta"; delta: string }
  | { type: "message.assistant.final"; content: string; id?: UUID; toolCalls?: ToolCall[] }
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
  }
  | { type: "message.user"; message: ParsedUserMessage };

export interface ParsedUserMessage {
  role: "user";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
    | { type: "image"; source: { type: "base64"; mediaType: string; data: string } }
  >;
}

/**
 * Marker type indicating an event was recognized but intentionally ignored.
 * Distinguished from `null` which means truly unrecognized.
 */
export type IgnoredCliEvent = { type: "ignored"; eventType: string };

/**
 * Result of parsing a CLI event line:
 * - ParsedCliEvent: successfully parsed event to emit
 * - IgnoredCliEvent: recognized event type but intentionally not emitted
 * - null: unrecognized event type
 */
export type ParsedCliEventResult = ParsedCliEvent | IgnoredCliEvent | null;

export function isIgnoredEvent(result: ParsedCliEventResult): result is IgnoredCliEvent {
  return result !== null && result.type === "ignored";
}

function isResolutionStatus(value: string): value is ApprovalResolution["status"] {
  return value === "approved" || value === "denied" || value === "modified";
}

export function parseCliEventLine(line: string): ParsedCliEventResult {
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

function ignored(eventType: string): IgnoredCliEvent {
  return { type: "ignored", eventType };
}

function parseCliEventObject(obj: JsonObject): ParsedCliEventResult {
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

    // Claude Code CLI init event: {"type":"system","subtype":"init",...}
    case "system": {
      return ignored("system");
    }
    // Gemini CLI stream-json init event
    case "init": {
      return ignored("init");
    }

    // Anthropic Native Events (recognized but not emitted)
    case "message_start": {
      return ignored("message_start");
    }
    case "message_delta": {
      return ignored("message_delta");
    }
    case "message_stop": {
      return ignored("message_stop");
    }
    case "content_block_start": {
      const contentBlock = asJsonObject(obj.content_block ?? null);
      if (!contentBlock) return null;
      const blockType = getString(contentBlock.type);
      if (blockType === "text") {
        const text = getString(contentBlock.text);
        // Empty text is normal - content comes in deltas
        return text ? { type: "message.assistant.delta", delta: text } : ignored("content_block_start:text");
      }
      if (blockType === "thinking") {
        const thinking = getString(contentBlock.thinking);
        return thinking ? { type: "message.assistant.thinking.delta", delta: thinking } : ignored("content_block_start:thinking");
      }
      if (blockType === "tool_use") {
        // Tool use blocks are handled by captureStreamToolUse
        return ignored("content_block_start:tool_use");
      }
      return null;
    }
    case "content_block_delta": {
      const delta = asJsonObject(obj.delta ?? null);
      if (!delta) return null;
      const deltaType = getString(delta.type);
      if (deltaType === "text_delta") {
        const text = getString(delta.text);
        return text ? { type: "message.assistant.delta", delta: text } : ignored("content_block_delta:text");
      }
      if (deltaType === "thinking_delta") {
        const thinking = getString(delta.thinking);
        return thinking ? { type: "message.assistant.thinking.delta", delta: thinking } : ignored("content_block_delta:thinking");
      }
      if (deltaType === "input_json_delta") {
        // Tool input deltas are handled by captureStreamToolUse
        return ignored("content_block_delta:input_json");
      }
      return null;
    }
    case "content_block_stop": {
      return ignored("content_block_stop");
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
      return { type: "message.assistant.final", content: text };
    }

    // Claude Code CLI user message echo
    case "user": {
      const message = asJsonObject(obj.message ?? null);
      if (!message) {
        return null;
      }
      const record = parseUserMessageRecord(message);
      return record ? { type: "message.user", message: record } : ignored("user_parse_failed");
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
      if (role !== "assistant") {
        return role ? ignored(`message:${role}`) : ignored("message");
      }
      if (!content) {
        return null;
      }
      const delta = getBoolean(obj.delta);
      if (delta === false) {
        return { type: "message.assistant.final", content };
      }
      return { type: "message.assistant.delta", delta: content };
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


function parseUserMessageRecord(value: JsonValue): ParsedUserMessage | null {
  const obj = asJsonObject(value);
  if (!obj) {
    return null;
  }
  const content = obj.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parsedContent: ParsedUserMessage["content"] = [];
  for (const item of content) {
    const itemObj = asJsonObject(item as JsonValue);
    if (!itemObj) continue;
    const type = getString(itemObj.type);
    if (type === "text") {
      const text = getString(itemObj.text);
      if (text) {
        parsedContent.push({ type: "text", text });
      }
    } else if (type === "tool_result") {
      const toolUseId = getString(itemObj.tool_use_id);
      const contentStr = getString(itemObj.content);
      const isError = getBoolean(itemObj.is_error);
      if (toolUseId && contentStr) {
        parsedContent.push({
          type: "tool_result",
          toolUseId,
          content: contentStr,
          ...(isError ? { isError } : {})
        });
      }
    } else if (type === "image") {
      const source = asJsonObject(itemObj.source ?? null);
      if (source && getString(source.type) === "base64") {
        const mediaType = getString(source.media_type);
        const data = getString(source.data);
        if (mediaType && data) {
          parsedContent.push({ type: "image", source: { type: "base64", mediaType, data } });
        }
      }
    }
  }

  if (parsedContent.length === 0) {
    return null;
  }

  return {
    role: "user",
    content: parsedContent
  };
}
