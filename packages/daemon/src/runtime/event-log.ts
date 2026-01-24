import { createReadStream, promises as fs } from "fs";
import path from "path";
import { createInterface } from "readline";
import type { EventEnvelope, UUID } from "@vuhlp/contracts";
import type { Logger } from "@vuhlp/providers";

const EVENT_LOG_BLOCK_SIZE = 64 * 1024;

export interface EventLogPage {
  events: EventEnvelope[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface ReadPageOptions {
  limit: number;
  before?: number;
}

interface EventLogLine {
  offset: number;
  value: string;
}

export class EventLog {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly runId: UUID;
  private readonly logger?: Logger;

  constructor(baseDir: string, runId: UUID, logger?: Logger) {
    this.dir = path.join(baseDir, "runs", runId);
    this.filePath = path.join(this.dir, "events.jsonl");
    this.runId = runId;
    this.logger = logger;
  }

  async append(event: EventEnvelope): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const line = `${JSON.stringify(event)}\n`;
      await fs.appendFile(this.filePath, line, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error("failed to append event log", { runId: this.runId, message });
      throw error;
    }
  }

  async readPage(options: ReadPageOptions): Promise<EventLogPage> {
    const limit = options.limit;
    if (limit <= 0) {
      return { events: [], nextCursor: null, hasMore: false };
    }

    const fileSize = await this.getFileSize();
    if (fileSize === 0) {
      return { events: [], nextCursor: null, hasMore: false };
    }

    const endOffset = this.clampOffset(options.before ?? fileSize, fileSize);
    if (endOffset === 0) {
      return { events: [], nextCursor: null, hasMore: false };
    }

    const lines = await this.readLinesFromTail(limit, endOffset);
    const events: EventEnvelope[] = [];
    for (const line of lines) {
      const event = this.parseEventLine(line.value);
      if (event) {
        events.push(event);
      }
    }

    const earliestOffset = lines.length > 0 ? lines[0].offset : null;
    const hasMore = earliestOffset !== null ? earliestOffset > 0 : false;
    const nextCursor = earliestOffset !== null && earliestOffset > 0 ? String(earliestOffset) : null;

    return { events, nextCursor, hasMore };
  }

  async replay(onEvent: (event: EventEnvelope) => void): Promise<number> {
    const fileSize = await this.getFileSize();
    if (fileSize === 0) {
      return 0;
    }

    let count = 0;
    try {
      const stream = createReadStream(this.filePath, { encoding: "utf8" });
      const reader = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of reader) {
        const event = this.parseEventLine(line);
        if (!event) {
          continue;
        }
        onEvent(event);
        count += 1;
      }
      return count;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error("failed to replay event log", { runId: this.runId, message });
      throw error;
    }
  }

  private parseEventLine(line: string): EventEnvelope | null {
    if (!line || line.trim().length === 0) {
      return null;
    }
    try {
      return JSON.parse(line) as EventEnvelope;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn("failed to parse event log line", { runId: this.runId, message });
      return null;
    }
  }

  private async getFileSize(): Promise<number> {
    try {
      const stat = await fs.stat(this.filePath);
      return stat.size;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  private clampOffset(offset: number, max: number): number {
    if (Number.isNaN(offset)) {
      return 0;
    }
    if (offset < 0) {
      return 0;
    }
    if (offset > max) {
      return max;
    }
    return offset;
  }

  private async readLinesFromTail(limit: number, endOffset: number): Promise<EventLogLine[]> {
    const file = await fs.open(this.filePath, "r");
    try {
      let offset = endOffset;
      let remainder = Buffer.alloc(0);
      const lines: EventLogLine[] = [];

      while (offset > 0 && lines.length < limit) {
        const readSize = Math.min(EVENT_LOG_BLOCK_SIZE, offset);
        offset -= readSize;
        const buffer = Buffer.alloc(readSize);
        const { bytesRead } = await file.read(buffer, 0, readSize, offset);
        if (bytesRead <= 0) {
          break;
        }
        const chunk = buffer.subarray(0, bytesRead);
        const combined = remainder.length > 0 ? Buffer.concat([chunk, remainder]) : chunk;

        let end = combined.length;
        for (let i = combined.length - 1; i >= 0; i -= 1) {
          if (combined[i] !== 0x0a) {
            continue;
          }
          const lineBuffer = combined.subarray(i + 1, end);
          if (lineBuffer.length > 0) {
            lines.push({ offset: offset + i + 1, value: lineBuffer.toString("utf8") });
            if (lines.length >= limit) {
              remainder = combined.subarray(0, i);
              break;
            }
          }
          end = i;
        }

        if (lines.length >= limit) {
          break;
        }

        remainder = combined.subarray(0, end);
      }

      if (lines.length < limit && remainder.length > 0) {
        lines.push({ offset: 0, value: remainder.toString("utf8") });
      }

      return lines.reverse();
    } finally {
      await file.close();
    }
  }
}
