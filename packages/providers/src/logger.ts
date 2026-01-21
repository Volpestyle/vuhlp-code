export type LogMetaValue = string | number | boolean | null | undefined | object;
export type LogMeta = Record<string, LogMetaValue>;
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

export interface ConsoleLoggerOptions {
  scope?: string;
  useColor?: boolean;
  minLevel?: LogLevel;
  inlineMetaLimit?: number;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR"
};

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m"
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: ANSI.gray,
  info: ANSI.green,
  warn: ANSI.yellow,
  error: ANSI.red
};

const DEFAULT_INLINE_META_LIMIT = 120;

function pad(value: number, length = 2): string {
  return value.toString().padStart(length, "0");
}

function formatTimestamp(now: Date): string {
  return [
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(
      now.getMilliseconds(),
      3
    )}`
  ].join(" ");
}

function colorize(text: string, color: string, enabled: boolean): string {
  if (!enabled) {
    return text;
  }
  return `${color}${text}${ANSI.reset}`;
}

function resolveColorEnabled(stream: NodeJS.WriteStream | undefined, override?: boolean): boolean {
  if (override !== undefined) {
    return override;
  }
  if (typeof process === "undefined") {
    return false;
  }
  const env = process.env;
  if (env.NO_COLOR !== undefined) {
    return false;
  }
  const forced = env.FORCE_COLOR;
  if (forced !== undefined) {
    return forced !== "0";
  }
  return Boolean(stream?.isTTY);
}

function normalizeMeta(meta: LogMeta): LogMeta {
  const normalized: LogMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      normalized[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

function safeStringify(meta: LogMeta, pretty: boolean): string {
  const spacing: number | undefined = pretty ? 2 : undefined;
  try {
    return JSON.stringify(meta, null, spacing);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: "Failed to serialize log meta", message });
  }
}

function formatMeta(
  meta: LogMeta | undefined,
  options: { colorEnabled: boolean; inlineLimit: number }
): string {
  if (!meta) {
    return "";
  }
  const normalized = normalizeMeta(meta);
  if (Object.keys(normalized).length === 0) {
    return "";
  }
  const inline = safeStringify(normalized, false);
  if (inline.length <= options.inlineLimit) {
    const inlineText = `meta=${inline}`;
    return ` ${colorize(inlineText, ANSI.dim, options.colorEnabled)}`;
  }
  const pretty = safeStringify(normalized, true);
  const indented = pretty
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  const label = colorize("meta:", ANSI.dim, options.colorEnabled);
  const body = colorize(indented, ANSI.dim, options.colorEnabled);
  return `\n${label}\n${body}`;
}

export class ConsoleLogger implements Logger {
  private readonly scope?: string;
  private readonly minLevel: number;
  private readonly useColor?: boolean;
  private readonly inlineMetaLimit: number;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.scope = options.scope;
    this.minLevel = LEVEL_PRIORITY[options.minLevel ?? "debug"];
    this.useColor = options.useColor;
    this.inlineMetaLimit = options.inlineMetaLimit ?? DEFAULT_INLINE_META_LIMIT;
  }

  debug(message: string, meta?: LogMeta): void {
    this.log("debug", message, meta);
  }

  info(message: string, meta?: LogMeta): void {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: LogMeta): void {
    this.log("warn", message, meta);
  }

  error(message: string, meta?: LogMeta): void {
    this.log("error", message, meta);
  }

  private log(level: LogLevel, message: string, meta?: LogMeta): void {
    if (LEVEL_PRIORITY[level] < this.minLevel) {
      return;
    }
    const stream = this.getStream(level);
    const colorEnabled = resolveColorEnabled(stream, this.useColor);
    const line = this.formatLine(level, message, meta, colorEnabled);
    if (stream) {
      this.writeToStream(stream, line);
      return;
    }
    this.writeToConsole(level, line);
  }

  private formatLine(
    level: LogLevel,
    message: string,
    meta: LogMeta | undefined,
    colorEnabled: boolean
  ): string {
    const timestamp = formatTimestamp(new Date());
    const levelLabel = LEVEL_LABELS[level].padEnd(5, " ");
    const parts = [
      colorize(timestamp, ANSI.dim, colorEnabled),
      colorize(levelLabel, LEVEL_COLORS[level], colorEnabled)
    ];
    if (this.scope) {
      parts.push(colorize(this.scope, ANSI.magenta, colorEnabled));
    }
    const prefix = parts.join(" ");
    const metaSuffix = formatMeta(meta, {
      colorEnabled,
      inlineLimit: this.inlineMetaLimit
    });
    return `${prefix} ${message}${metaSuffix}`;
  }

  private getStream(level: LogLevel): NodeJS.WriteStream | undefined {
    if (typeof process === "undefined") {
      return undefined;
    }
    return level === "warn" || level === "error" ? process.stderr : process.stdout;
  }

  private writeToStream(stream: NodeJS.WriteStream, line: string): void {
    try {
      stream.write(`${line}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("logger write failed", { message, line });
    }
  }

  private writeToConsole(level: LogLevel, line: string): void {
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    if (level === "info") {
      console.info(line);
      return;
    }
    console.debug(line);
  }
}
