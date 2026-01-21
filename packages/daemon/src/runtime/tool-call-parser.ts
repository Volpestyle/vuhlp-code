/**
 * Tool call parsing utilities
 *
 * Extracts and parses tool call JSON from assistant message text.
 */

import type { ToolCall, UUID } from "@vuhlp/contracts";
import type { Logger } from "@vuhlp/providers";
import { newId } from "./utils.js";

/**
 * Type guard to check if value is a record object
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ExtractedToolCalls {
  message: string;
  toolCalls: ToolCall[];
}

export interface ToolCallParseOptions {
  strictWrapper?: boolean;
  allowlist?: ReadonlySet<string>;
}

/**
 * Extracts tool call JSON lines from a message
 *
 * Scans through the message line by line, attempting to parse each line
 * as a tool call JSON object. Lines that parse successfully are removed
 * from the message and returned as tool calls.
 */
export function extractToolCalls(
  message: string,
  nodeId: UUID | undefined,
  logger?: Logger,
  options?: ToolCallParseOptions
): ExtractedToolCalls {
  const lines = message.split("\n");
  const toolCalls: ToolCall[] = [];
  const keptLines: string[] = [];

  for (const line of lines) {
    const toolCall = parseToolCallLine(line, nodeId, logger, options);
    if (toolCall) {
      toolCalls.push(toolCall);
      continue;
    }
    keptLines.push(line);
  }

  if (toolCalls.length === 0) {
    return { message, toolCalls };
  }

  return { message: keptLines.join("\n").trim(), toolCalls };
}

/**
 * Attempts to parse a single line as a tool call JSON object
 *
 * Supports multiple formats:
 * - { "tool_call": { "id": "...", "name": "...", "args": {...} } }
 * - { "toolCall": { "name": "...", "args": {...} } }
 * - { "tool": "...", "args": {...} }
 * - { "name": "...", "args": {...} }
 */
export function parseToolCallLine(
  line: string,
  nodeId: UUID | undefined,
  logger?: Logger,
  options?: ToolCallParseOptions
): ToolCall | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    logger?.warn("failed to parse tool call JSON", {
      nodeId,
      message: String(error)
    });
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  // Check for tool_call or toolCall wrapper
  const container = isRecord(parsed.tool_call)
    ? parsed.tool_call
    : isRecord(parsed.toolCall)
      ? parsed.toolCall
      : null;

  if (!container) {
    if (options?.strictWrapper) {
      const directName =
        typeof parsed.tool === "string"
          ? parsed.tool.trim()
          : typeof parsed.name === "string"
            ? parsed.name.trim()
            : "";
      if (directName) {
        logger?.debug("ignored tool_call without wrapper in strict mode", {
          nodeId,
          tool: directName
        });
      }
      return null;
    }
    // Try direct properties (nonstandard format)
    const directName =
      typeof parsed.tool === "string"
        ? parsed.tool.trim()
        : typeof parsed.name === "string"
          ? parsed.name.trim()
          : "";
    const directArgs = isRecord(parsed.args)
      ? parsed.args
      : isRecord(parsed.params)
        ? parsed.params
        : null;

    if (!directName || !directArgs) {
      return null;
    }

    const directId = typeof parsed.id === "string" ? parsed.id.trim() : "";
    const id = directId.length > 0 ? directId : newId();

    if (options?.allowlist && !options.allowlist.has(directName)) {
      logger?.debug("ignored tool_call not in allowlist", {
        nodeId,
        tool: directName
      });
      return null;
    }
    if (!options?.strictWrapper) {
      logger?.warn("nonstandard tool_call JSON shape; prefer tool_call wrapper", {
        nodeId,
        tool: directName
      });
    }

    return { id, name: directName, args: directArgs };
  }

  // Standard format with tool_call/toolCall wrapper
  const name = typeof container.name === "string" ? container.name.trim() : "";
  const args = isRecord(container.args)
    ? container.args
    : isRecord(container.params)
      ? container.params
      : null;

  if (!isRecord(container.args) && isRecord(container.params)) {
    logger?.warn("tool_call JSON used params; prefer args", {
      nodeId,
      tool: name
    });
  }

  const idValue = typeof container.id === "string" ? container.id.trim() : "";
  const id = idValue.length > 0 ? idValue : newId();

  if (!name || !args) {
    return null;
  }

  if (options?.allowlist && !options.allowlist.has(name)) {
    logger?.debug("ignored tool_call not in allowlist", {
      nodeId,
      tool: name
    });
    return null;
  }

  return { id, name, args };
}

/**
 * Merges native tool calls with JSON-extracted tool calls
 *
 * Native calls take precedence; duplicate IDs from JSON calls are skipped.
 */
export function mergeToolCalls(
  nativeCalls: ToolCall[],
  jsonCalls: ToolCall[],
  nodeId: UUID,
  logger?: Logger
): ToolCall[] {
  if (nativeCalls.length === 0) {
    return jsonCalls;
  }
  if (jsonCalls.length === 0) {
    return nativeCalls;
  }

  const seenIds = new Set<string>();
  const merged: ToolCall[] = [];

  for (const tool of nativeCalls) {
    seenIds.add(tool.id);
    merged.push(tool);
  }

  let skipped = 0;
  for (const tool of jsonCalls) {
    if (seenIds.has(tool.id)) {
      skipped += 1;
      continue;
    }
    seenIds.add(tool.id);
    merged.push(tool);
  }

  logger?.info("merging native tool calls with tool_call JSON", {
    nodeId,
    nativeCount: nativeCalls.length,
    jsonCount: jsonCalls.length,
    mergedCount: merged.length,
    skippedCount: skipped
  });

  return merged;
}
