import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import readline from "node:readline";

export async function loadEnvFile(path: string): Promise<void> {
  if (!path) return;
  try {
    await access(path);
  } catch {
    return;
  }

  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const raw of rl) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trim();
    }
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    let val = line.slice(idx + 1).trim();
    if (val.length >= 2) {
      const first = val[0];
      const last = val[val.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        val = val.slice(1, -1);
      }
    }
    process.env[key] = val;
  }
}
