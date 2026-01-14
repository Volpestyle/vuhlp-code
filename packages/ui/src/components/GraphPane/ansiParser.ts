/**
 * ANSI Escape Code Parser
 * Converts ANSI terminal color codes to styled React elements
 */

import { ReactNode, createElement } from 'react';

interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
  opacity?: number;
}

interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

// Standard ANSI color palette (0-7 normal, 8-15 bright)
const ANSI_COLORS: Record<number, string> = {
  0: '#1e1e2e',   // Black
  1: '#f87171',   // Red
  2: '#4ade80',   // Green
  3: '#fbbf24',   // Yellow
  4: '#60a5fa',   // Blue
  5: '#c084fc',   // Magenta
  6: '#22d3ee',   // Cyan
  7: '#e2e8f0',   // White
  8: '#6b7280',   // Bright Black (Gray)
  9: '#fca5a5',   // Bright Red
  10: '#86efac',  // Bright Green
  11: '#fde047',  // Bright Yellow
  12: '#93c5fd',  // Bright Blue
  13: '#d8b4fe',  // Bright Magenta
  14: '#67e8f9',  // Bright Cyan
  15: '#f8fafc',  // Bright White
};

// Extended 256-color palette ranges
function get256Color(code: number): string {
  if (code < 16) {
    return ANSI_COLORS[code];
  }
  if (code >= 16 && code < 232) {
    // 216-color cube (6x6x6)
    const n = code - 16;
    const b = n % 6;
    const g = Math.floor(n / 6) % 6;
    const r = Math.floor(n / 36);
    const toHex = (v: number) => (v === 0 ? 0 : 55 + v * 40).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  // Grayscale (232-255)
  const gray = 8 + (code - 232) * 10;
  const hex = gray.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

function parseAnsiCodes(codes: number[], currentStyle: AnsiStyle): AnsiStyle {
  const style = { ...currentStyle };
  let i = 0;

  while (i < codes.length) {
    const code = codes[i];

    switch (code) {
      case 0: // Reset
        return {};
      case 1: // Bold
        style.fontWeight = '600';
        break;
      case 2: // Dim
        style.opacity = 0.7;
        break;
      case 3: // Italic
        style.fontStyle = 'italic';
        break;
      case 4: // Underline
        style.textDecoration = 'underline';
        break;
      case 22: // Normal intensity
        delete style.fontWeight;
        delete style.opacity;
        break;
      case 23: // Not italic
        delete style.fontStyle;
        break;
      case 24: // Not underline
        delete style.textDecoration;
        break;
      case 30: case 31: case 32: case 33:
      case 34: case 35: case 36: case 37:
        style.color = ANSI_COLORS[code - 30];
        break;
      case 38: // Extended foreground
        if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
          style.color = get256Color(codes[i + 2]);
          i += 2;
        } else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
          const r = codes[i + 2];
          const g = codes[i + 3];
          const b = codes[i + 4];
          style.color = `rgb(${r},${g},${b})`;
          i += 4;
        }
        break;
      case 39: // Default foreground
        delete style.color;
        break;
      case 40: case 41: case 42: case 43:
      case 44: case 45: case 46: case 47:
        style.backgroundColor = ANSI_COLORS[code - 40];
        break;
      case 48: // Extended background
        if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
          style.backgroundColor = get256Color(codes[i + 2]);
          i += 2;
        } else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
          const r = codes[i + 2];
          const g = codes[i + 3];
          const b = codes[i + 4];
          style.backgroundColor = `rgb(${r},${g},${b})`;
          i += 4;
        }
        break;
      case 49: // Default background
        delete style.backgroundColor;
        break;
      case 90: case 91: case 92: case 93:
      case 94: case 95: case 96: case 97:
        style.color = ANSI_COLORS[code - 90 + 8];
        break;
      case 100: case 101: case 102: case 103:
      case 104: case 105: case 106: case 107:
        style.backgroundColor = ANSI_COLORS[code - 100 + 8];
        break;
    }
    i++;
  }

  return style;
}

export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  // Match ANSI escape sequences: \x1b[ or \033[ followed by params and ending with 'm'
  const ansiRegex = /\x1b\[([0-9;]*)m/g;

  let currentStyle: AnsiStyle = {};
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ansiRegex.exec(text)) !== null) {
    // Add text before this escape sequence
    if (match.index > lastIndex) {
      const textBefore = text.slice(lastIndex, match.index);
      if (textBefore) {
        segments.push({ text: textBefore, style: { ...currentStyle } });
      }
    }

    // Parse the escape codes
    const codes = match[1]
      .split(';')
      .filter(s => s !== '')
      .map(s => parseInt(s, 10));

    if (codes.length === 0) {
      currentStyle = {};
    } else {
      currentStyle = parseAnsiCodes(codes, currentStyle);
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), style: { ...currentStyle } });
  }

  return segments;
}

export function renderAnsi(text: string, baseClassName?: string): ReactNode[] {
  const segments = parseAnsi(text);

  return segments.map((segment, index) => {
    const hasStyle = Object.keys(segment.style).length > 0;

    if (!hasStyle) {
      return segment.text;
    }

    return createElement(
      'span',
      {
        key: index,
        className: baseClassName,
        style: segment.style,
      },
      segment.text
    );
  });
}

// Strip ANSI codes for plain text
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
