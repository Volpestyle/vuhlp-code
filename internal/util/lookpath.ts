import { access } from "node:fs/promises";
import path from "node:path";

export async function lookPath(cmd: string): Promise<string> {
  if (!cmd) throw new Error("command is empty");
  if (cmd.includes(path.sep)) {
    await access(cmd);
    return cmd;
  }
  const envPath = process.env.PATH || "";
  const parts = envPath.split(path.delimiter);
  for (const dir of parts) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      await access(full);
      return full;
    } catch {
      // continue
    }
  }
  throw new Error(`command not found: ${cmd}`);
}
