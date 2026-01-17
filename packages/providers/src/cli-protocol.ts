import type { ApprovalResolution, ToolCall, UUID } from "@vuhlp/contracts";
import { asJsonObject, getBoolean, getString, parseJsonValue } from "./json.js";
import type { JsonObject, JsonValue } from "./json.js";

export type ParsedCliEvent =
  | { type: "message.assistant.delta"; delta: string }
  | { type: "message.assistant.final"; content: string }
  | { type: "tool.proposed"; tool: ToolCall }
  | { type: "tool.started"; tool: ToolCall }
  | { type: "tool.completed"; toolId: UUID; result: { ok: boolean }; error?: { message: string } }
  | { type: "approval.requested"; approvalId: UUID; tool: ToolCall; context?: string }
  | { type: "approval.resolved"; approvalId: UUID; resolution: ApprovalResolution };

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

function parseCliEventObject(obj: JsonObject): ParsedCliEvent | null {
  const type = getString(obj.type);
  if (!type) {
    return null;
  }

  switch (type) {
    case "message.assistant.delta": {
      const delta = getString(obj.delta);
      return delta ? { type, delta } : null;
    }
    case "message.assistant.final": {
      const content = getString(obj.content);
      return content ? { type, content } : null;
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
    default:
      return null;
  }
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

function parseToolResult(value: JsonValue): { ok: boolean } | null {
  const obj = asJsonObject(value);
  if (!obj) {
    return null;
  }
  const ok = getBoolean(obj.ok);
  if (ok === null) {
    return null;
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
