/**
 * Utilities for detecting and filtering tool call JSON from streamed content
 *
 * Used by both web UI and mobile stores to clean up assistant messages
 * that may contain raw tool call JSON inline with the response text.
 */

/**
 * Type guard to check if a value is a record object
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks if a line of text appears to be a tool call JSON object
 *
 * Detects various formats:
 * - { "tool_call": { "name": "...", "args": {...} } }
 * - { "toolCall": { "name": "...", "args": {...} } }
 * - { "tool": "...", "args": {...} }
 * - { "name": "...", "args": {...} }
 * - { "name": "...", "params": {...} }
 */
export const isToolCallLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }

  if (!isRecord(parsed)) {
    return false;
  }

  // Check for nested tool_call or toolCall container
  const container = isRecord(parsed.tool_call)
    ? parsed.tool_call
    : isRecord(parsed.toolCall)
      ? parsed.toolCall
      : null;

  if (container) {
    const name = typeof container.name === 'string' ? container.name.trim() : '';
    const args = isRecord(container.args)
      ? container.args
      : isRecord(container.params)
        ? container.params
        : null;
    return Boolean(name && args);
  }

  // Check for direct tool/name property
  const directName =
    typeof parsed.tool === 'string'
      ? parsed.tool.trim()
      : typeof parsed.name === 'string'
        ? parsed.name.trim()
        : '';
  const directArgs = isRecord(parsed.args)
    ? parsed.args
    : isRecord(parsed.params)
      ? parsed.params
      : null;

  return Boolean(directName && directArgs);
};

/**
 * Removes lines that look like tool call JSON from streamed content
 *
 * This is used to clean up assistant messages that may have raw tool
 * call JSON embedded in the response due to streaming artifacts.
 */
export const stripToolCallLines = (content: string): string => {
  if (!content) {
    return content;
  }
  const lines = content.split('\n');
  const kept = lines.filter((line) => !isToolCallLine(line));
  return kept.join('\n');
};
