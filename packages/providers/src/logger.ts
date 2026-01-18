export type LogMetaValue = string | number | boolean | null | undefined | object;
export type LogMeta = Record<string, LogMetaValue>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

function formatMeta(meta?: LogMeta): string {
  if (!meta) {
    return "";
  }
  return ` ${JSON.stringify(meta)}`;
}

export class ConsoleLogger implements Logger {
  debug(message: string, meta?: LogMeta): void {
    console.debug(`${message}${formatMeta(meta)}`);
  }

  info(message: string, meta?: LogMeta): void {
    console.info(`${message}${formatMeta(meta)}`);
  }

  warn(message: string, meta?: LogMeta): void {
    console.warn(`${message}${formatMeta(meta)}`);
  }

  error(message: string, meta?: LogMeta): void {
    console.error(`${message}${formatMeta(meta)}`);
  }
}
