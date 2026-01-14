import { ReactNode } from 'react';

/**
 * Parsed segment types for message content
 */
export interface ParsedSegment {
  type: 'text' | 'json' | 'code' | 'status';
  content: string;
  language?: string; // For code blocks
  data?: Record<string, unknown>; // Parsed JSON data for json/status types
}

/**
 * Try to find a balanced JSON object starting at position i
 * Returns the end position (exclusive) or -1 if not valid JSON
 */
function findJsonEnd(str: string, startIndex: number): number {
  if (str[startIndex] !== '{') return -1;

  let depth = 0;
  let inString = false;
  let i = startIndex;

  while (i < str.length) {
    const char = str[i];

    // Handle escape sequences (both \\ and \")
    if (char === '\\' && i + 1 < str.length) {
      i += 2; // Skip the escaped character
      continue;
    }

    if (char === '"') {
      inString = !inString;
      i++;
      continue;
    }

    if (inString) {
      i++;
      continue;
    }

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
    i++;
  }

  return -1; // Unbalanced
}

/**
 * Try to find a balanced ESCAPED JSON object starting at position i
 * Escaped JSON looks like: {\"key\": \"value\"}
 * Returns the end position (exclusive) or -1 if not valid
 */
function findEscapedJsonEnd(str: string, startIndex: number): number {
  if (str[startIndex] !== '{') return -1;

  let depth = 0;
  let inString = false;
  let i = startIndex;

  while (i < str.length) {
    // Check for escaped quote: \"
    if (str[i] === '\\' && str[i + 1] === '"') {
      inString = !inString;
      i += 2;
      continue;
    }

    // Check for escaped backslash: \\
    if (str[i] === '\\' && str[i + 1] === '\\') {
      i += 2;
      continue;
    }

    if (inString) {
      i++;
      continue;
    }

    if (str[i] === '{') {
      depth++;
    } else if (str[i] === '}') {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
    i++;
  }

  return -1;
}

/**
 * Unescape a JSON string that has escaped quotes
 */
function unescapeJson(str: string): string {
  return str
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

/**
 * Parses message content to extract JSON blocks, code blocks, and plain text
 */
export function parseMessageContent(content: string): ParsedSegment[] {
  if (!content) return [];

  const segments: ParsedSegment[] = [];

  // Pattern to match fenced code blocks
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;

  // First pass: extract all fenced code blocks
  const codeBlockMatches: Array<{ start: number; end: number; segment: ParsedSegment }> = [];
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const fullMatch = match[0];
    const language = match[1] || '';
    const codeContent = match[2].trim();

    let isJson = false;
    let parsedData: Record<string, unknown> | undefined;

    if (language === 'json' || !language) {
      try {
        parsedData = JSON.parse(codeContent);
        isJson = true;
      } catch {
        // Not valid JSON
      }
    }

    codeBlockMatches.push({
      start: match.index,
      end: match.index + fullMatch.length,
      segment: isJson && parsedData
        ? { type: isStatusJson(parsedData) ? 'status' : 'json', content: codeContent, data: parsedData }
        : { type: 'code', content: codeContent, language: language || 'text' },
    });
  }

  // Mark positions covered by code blocks
  const coveredRanges = codeBlockMatches.map(m => ({ start: m.start, end: m.end }));

  function isPositionCovered(pos: number): boolean {
    return coveredRanges.some(r => pos >= r.start && pos < r.end);
  }

  // Second pass: find inline JSON objects (not inside code blocks)
  // Check for both regular JSON and escaped JSON (with \")
  const jsonMatches: Array<{ start: number; end: number; segment: ParsedSegment }> = [];

  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{' && !isPositionCovered(i)) {
      // First try regular JSON
      let endPos = findJsonEnd(content, i);
      let jsonStr = endPos > i ? content.slice(i, endPos) : '';
      let isEscaped = false;

      // If regular JSON parse fails, try escaped JSON
      if (jsonStr.length > 10) {
        try {
          JSON.parse(jsonStr);
        } catch {
          // Try escaped JSON detection
          const escapedEndPos = findEscapedJsonEnd(content, i);
          if (escapedEndPos > i) {
            const escapedStr = content.slice(i, escapedEndPos);
            const unescaped = unescapeJson(escapedStr);
            try {
              JSON.parse(unescaped);
              jsonStr = escapedStr;
              endPos = escapedEndPos;
              isEscaped = true;
            } catch {
              // Not valid escaped JSON either
              jsonStr = '';
            }
          } else {
            jsonStr = '';
          }
        }
      }

      if (jsonStr.length > 10) {
        try {
          const parseStr = isEscaped ? unescapeJson(jsonStr) : jsonStr;
          const parsedData = JSON.parse(parseStr);
          if (typeof parsedData === 'object' && parsedData !== null) {
            jsonMatches.push({
              start: i,
              end: endPos,
              segment: {
                type: isStatusJson(parsedData) ? 'status' : 'json',
                content: parseStr, // Store the unescaped version for display
                data: parsedData,
              },
            });
            i = endPos - 1; // Skip past this JSON
          }
        } catch {
          // Not valid JSON, continue
        }
      }
    }
  }

  // Combine all matches and sort by position
  const allMatches = [...codeBlockMatches, ...jsonMatches].sort((a, b) => a.start - b.start);

  // Build segments
  let lastIndex = 0;
  for (const block of allMatches) {
    if (block.start > lastIndex) {
      const textBefore = content.slice(lastIndex, block.start).trim();
      if (textBefore) {
        segments.push({ type: 'text', content: textBefore });
      }
    }
    segments.push(block.segment);
    lastIndex = block.end;
  }

  // Handle remaining content
  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex).trim();
    if (remaining) {
      segments.push({ type: 'text', content: remaining });
    }
  }

  return segments;
}

/**
 * Checks if the JSON object looks like a status response
 */
function isStatusJson(data: Record<string, unknown>): boolean {
  // Common status patterns: { "status": "..." } or { "result": "..." }
  const keys = Object.keys(data);
  if (keys.length <= 3) {
    return keys.some(k => ['status', 'result', 'state', 'done', 'type'].includes(k.toLowerCase()));
  }
  return false;
}

/**
 * Truncate a string value for display, preserving some context
 */
function truncateStringValue(str: string, maxLength: number = 80): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '...';
}

/**
 * Create a summarized version of JSON for display
 * Truncates long string values and formats nicely
 */
export function summarizeJsonForDisplay(data: unknown, maxStringLength: number = 80): string {
  if (data === null || data === undefined) return String(data);

  const summarize = (value: unknown, depth: number = 0): unknown => {
    if (depth > 10) return '[nested]';

    if (typeof value === 'string') {
      return truncateStringValue(value, maxStringLength);
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return [];
      if (value.length > 5) {
        return [...value.slice(0, 3).map(v => summarize(v, depth + 1)), `... ${value.length - 3} more`];
      }
      return value.map(v => summarize(v, depth + 1));
    }

    if (typeof value === 'object' && value !== null) {
      const result: Record<string, unknown> = {};
      const entries = Object.entries(value);
      for (const [k, v] of entries) {
        result[k] = summarize(v, depth + 1);
      }
      return result;
    }

    return value;
  };

  try {
    const summarized = summarize(data);
    return JSON.stringify(summarized, null, 2);
  } catch {
    return String(data);
  }
}

/**
 * Format JSON with syntax highlighting
 */
export function formatJsonWithHighlight(data: unknown, options?: { summarize?: boolean }): ReactNode {
  if (data === null || data === undefined) return null;

  try {
    let str: string;
    if (typeof data === 'string') {
      str = data;
    } else if (options?.summarize) {
      str = summarizeJsonForDisplay(data);
    } else {
      str = JSON.stringify(data, null, 2);
    }

    // Simple syntax highlighting for JSON
    const highlighted = str
      .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
      .replace(/: "([^"]*)"/g, ': <span class="json-string">"$1"</span>')
      .replace(/: (\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
      .replace(/: (true|false)/g, ': <span class="json-boolean">$1</span>')
      .replace(/: (null)/g, ': <span class="json-null">$1</span>');

    return <span dangerouslySetInnerHTML={{ __html: highlighted }} />;
  } catch {
    return String(data);
  }
}

/**
 * Get status badge class based on status value
 */
export function getStatusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (['done', 'completed', 'success', 'ok'].includes(normalized)) {
    return 'status--success';
  }
  if (['error', 'failed', 'failure'].includes(normalized)) {
    return 'status--error';
  }
  if (['pending', 'waiting', 'queued'].includes(normalized)) {
    return 'status--pending';
  }
  if (['running', 'in_progress', 'working'].includes(normalized)) {
    return 'status--running';
  }
  return 'status--default';
}
