import { readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

export interface ModelPolicy {
  require_tools: boolean;
  require_vision: boolean;
  max_cost_usd: number;
  preferred_models: string[];
}

export interface Config {
  listen_addr: string;
  data_dir: string;
  auth_token: string;
  model_policy: ModelPolicy;
}

export function defaultConfig(): Config {
  return {
    listen_addr: "127.0.0.1:8787",
    data_dir: "~/.agent-harness",
    auth_token: "",
    model_policy: {
      require_tools: false,
      require_vision: false,
      max_cost_usd: 5.0,
      preferred_models: [],
    },
  };
}

export function expandHome(value: string): string {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

export async function loadFromFile(filePath: string): Promise<Config> {
  if (!filePath) throw new Error("path is empty");
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as Config;
}
