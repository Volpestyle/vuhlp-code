import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ModelPolicy } from "./config";

export interface Settings {
  model_policy: ModelPolicy;
}

export async function loadSettings(filePath: string): Promise<{ settings: Settings; exists: boolean }> {
  if (!filePath) throw new Error("path is empty");
  try {
    const raw = await readFile(filePath, "utf8");
    return { settings: JSON.parse(raw) as Settings, exists: true };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { settings: { model_policy: { require_tools: false, require_vision: false, max_cost_usd: 5, preferred_models: [] } }, exists: false };
    }
    throw err;
  }
}

export async function saveSettings(filePath: string, settings: Settings): Promise<void> {
  if (!filePath) throw new Error("path is empty");
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const payload = JSON.stringify(settings, null, 2) + "\n";
  await writeFile(filePath, payload, { mode: 0o644 });
}
