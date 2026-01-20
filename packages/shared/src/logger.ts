/**
 * Platform-agnostic logger for web and mobile
 */

export type LogMetaValue = string | number | boolean | null | undefined | object;
export type LogMeta = Record<string, LogMetaValue>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

export interface LoggerOptions {
  scope?: string;
  minLevel?: LogLevel;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function pad(value: number, length = 2): string {
  return value.toString().padStart(length, '0');
}

function formatTimestamp(now: Date): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(
    now.getMilliseconds(),
    3
  )}`;
}

function normalizeMeta(meta: LogMeta): LogMeta {
  const normalized: LogMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      normalized[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

function safeStringify(meta: LogMeta): string {
  try {
    return JSON.stringify(meta);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: 'Failed to serialize log meta', message });
  }
}

/**
 * Simple logger that works in both web and React Native environments
 */
export class SimpleLogger implements Logger {
  private readonly scope?: string;
  private readonly minLevel: number;

  constructor(options: LoggerOptions = {}) {
    this.scope = options.scope;
    this.minLevel = LEVEL_PRIORITY[options.minLevel ?? 'debug'];
  }

  debug(message: string, meta?: LogMeta): void {
    this.log('debug', message, meta);
  }

  info(message: string, meta?: LogMeta): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: LogMeta): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: LogMeta): void {
    this.log('error', message, meta);
  }

  private log(level: LogLevel, message: string, meta?: LogMeta): void {
    if (LEVEL_PRIORITY[level] < this.minLevel) {
      return;
    }

    const timestamp = formatTimestamp(new Date());
    const scopePrefix = this.scope ? `[${this.scope}]` : '';
    const metaSuffix = meta && Object.keys(meta).length > 0
      ? ` ${safeStringify(normalizeMeta(meta))}`
      : '';

    const formattedMessage = `${timestamp} ${scopePrefix} ${message}${metaSuffix}`;

    switch (level) {
      case 'error':
        console.error(formattedMessage);
        break;
      case 'warn':
        console.warn(formattedMessage);
        break;
      case 'info':
        console.info(formattedMessage);
        break;
      case 'debug':
      default:
        console.debug(formattedMessage);
        break;
    }
  }
}

/**
 * Create a logger with an optional scope prefix
 */
export function createLogger(scope?: string, minLevel?: LogLevel): Logger {
  return new SimpleLogger({ scope, minLevel });
}

/**
 * Global default logger instance
 */
export const logger = new SimpleLogger();
