import { Text, type TextStyle } from 'react-native';
import { colors, fontFamily } from '@/lib/theme';

interface JsonSyntaxProps {
  data: unknown;
  style?: TextStyle;
}

// Token types for JSON syntax highlighting
type TokenType = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punctuation';

interface Token {
  type: TokenType;
  value: string;
}

const tokenColors: Record<TokenType, string> = {
  key: '#7dd3fc',      // Light cyan for keys
  string: '#86efac',   // Light green for strings
  number: '#fcd34d',   // Amber for numbers
  boolean: '#c4b5fd',  // Light purple for booleans
  null: '#c4b5fd',     // Light purple for null
  punctuation: colors.textMuted,
};

/**
 * Tokenizes a JSON string into colored segments
 */
function tokenizeJson(json: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const charAt = (idx: number): string => json.charAt(idx);

  while (i < json.length) {
    const char = charAt(i);

    // Whitespace - include as punctuation to preserve formatting
    if (/\s/.test(char)) {
      let whitespace = '';
      while (i < json.length && /\s/.test(charAt(i))) {
        whitespace += charAt(i);
        i++;
      }
      tokens.push({ type: 'punctuation', value: whitespace });
      continue;
    }

    // Punctuation: { } [ ] , :
    if (/[{}\[\],:]/.test(char)) {
      tokens.push({ type: 'punctuation', value: char });
      i++;
      continue;
    }

    // String (key or value)
    if (char === '"') {
      let str = '"';
      i++;
      while (i < json.length && charAt(i) !== '"') {
        if (charAt(i) === '\\' && i + 1 < json.length) {
          str += charAt(i) + charAt(i + 1);
          i += 2;
        } else {
          str += charAt(i);
          i++;
        }
      }
      str += '"';
      i++;

      // Check if this is a key (followed by colon)
      let j = i;
      while (j < json.length && /\s/.test(charAt(j))) j++;
      const isKey = charAt(j) === ':';

      tokens.push({ type: isKey ? 'key' : 'string', value: str });
      continue;
    }

    // Number
    if (/[-\d]/.test(char)) {
      let num = '';
      while (i < json.length && /[-\d.eE+]/.test(charAt(i))) {
        num += charAt(i);
        i++;
      }
      tokens.push({ type: 'number', value: num });
      continue;
    }

    // Boolean or null
    if (json.slice(i, i + 4) === 'true') {
      tokens.push({ type: 'boolean', value: 'true' });
      i += 4;
      continue;
    }
    if (json.slice(i, i + 5) === 'false') {
      tokens.push({ type: 'boolean', value: 'false' });
      i += 5;
      continue;
    }
    if (json.slice(i, i + 4) === 'null') {
      tokens.push({ type: 'null', value: 'null' });
      i += 4;
      continue;
    }

    // Unknown character - treat as punctuation
    tokens.push({ type: 'punctuation', value: char });
    i++;
  }

  return tokens;
}

/**
 * Renders JSON with syntax highlighting for React Native
 */
export function JsonSyntax({ data, style }: JsonSyntaxProps) {
  let jsonString: string;

  try {
    jsonString = JSON.stringify(data, null, 2);
  } catch (error) {
    console.error('[JsonSyntax] Failed to stringify data:', error);
    return (
      <Text style={[styles.base, styles.error, style]}>
        [Unable to display JSON]
      </Text>
    );
  }

  if (!jsonString || jsonString === 'undefined') {
    return (
      <Text style={[styles.base, style]}>null</Text>
    );
  }

  const tokens = tokenizeJson(jsonString);

  return (
    <Text style={[styles.base, style]} selectable>
      {tokens.map((token, index) => (
        <Text key={index} style={{ color: tokenColors[token.type] }}>
          {token.value}
        </Text>
      ))}
    </Text>
  );
}

const styles = {
  base: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    lineHeight: 16,
    color: colors.textPrimary,
  } as TextStyle,
  error: {
    color: colors.statusFailed,
  } as TextStyle,
};
