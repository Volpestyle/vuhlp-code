import { promises as fs } from "fs";
import path from "path";
import type { UUID } from "@vuhlp/contracts";

export class ArtifactStore {
  private readonly dir: string;

  constructor(baseDir: string, runId: UUID) {
    this.dir = path.join(baseDir, "runs", runId, "artifacts");
  }

  async writeArtifact(name: string, content: string): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true });
    const filePath = path.join(this.dir, name);
    await fs.writeFile(filePath, content, "utf8");
    return filePath;
  }
}
