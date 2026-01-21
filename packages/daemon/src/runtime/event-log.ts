import { promises as fs } from "fs";
import path from "path";
import type { EventEnvelope, UUID } from "@vuhlp/contracts";

export class EventLog {
  private readonly dir: string;
  private readonly filePath: string;

  constructor(baseDir: string, runId: UUID) {
    this.dir = path.join(baseDir, "runs", runId);
    this.filePath = path.join(this.dir, "events.jsonl");
  }

  async append(event: EventEnvelope): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const line = `${JSON.stringify(event)}\n`;
    await fs.appendFile(this.filePath, line, "utf8");
  }

  async readAll(): Promise<EventEnvelope[]> {
    try {
      const contents = await fs.readFile(this.filePath, "utf8");
      return contents
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EventEnvelope);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}
