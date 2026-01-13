import fs from "node:fs";
import path from "node:path";

export interface VuhlpConfig {
  server?: { port?: number };
  dataDir?: string;
  providers?: Record<string, any>;
  roles?: Record<string, string>;
  scheduler?: { maxConcurrency?: number };
  orchestration?: { maxIterations?: number };
  workspace?: { mode?: "shared" | "worktree" | "copy"; rootDir?: string };
  verification?: { commands?: string[] };
}

export function loadConfig(): VuhlpConfig {
  const defaultPath = path.resolve(process.cwd(), "vuhlp.config.json");
  const configPath = process.env.VUHLP_CONFIG
    ? path.resolve(process.env.VUHLP_CONFIG)
    : defaultPath;

  let cfg: VuhlpConfig = {};
  if (fs.existsSync(configPath)) {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")) as VuhlpConfig;
  }

  // Env overrides
  const portEnv = process.env.VUHLP_PORT;
  if (portEnv) {
    cfg.server = cfg.server ?? {};
    cfg.server.port = Number(portEnv);
  }
  const dataEnv = process.env.VUHLP_DATA_DIR;
  if (dataEnv) cfg.dataDir = dataEnv;

  // Defaults
  cfg.server = cfg.server ?? {};
  cfg.server.port = cfg.server.port ?? 4317;
  cfg.dataDir = cfg.dataDir ?? ".vuhlp";
  cfg.providers = cfg.providers ?? { mock: { kind: "mock" } };
  cfg.roles = cfg.roles ?? {
    investigator: "mock",
    planner: "mock",
    implementer: "mock",
    reviewer: "mock",
  };
  cfg.scheduler = cfg.scheduler ?? { maxConcurrency: 3 };
  cfg.orchestration = cfg.orchestration ?? { maxIterations: 3 };
  cfg.workspace = cfg.workspace ?? { mode: "shared", rootDir: ".vuhlp/workspaces" };
  cfg.verification = cfg.verification ?? { commands: [] };

  return cfg;
}

export function saveConfig(updates: Partial<VuhlpConfig>): void {
  const defaultPath = path.resolve(process.cwd(), "vuhlp.config.json");
  const configPath = process.env.VUHLP_CONFIG
    ? path.resolve(process.env.VUHLP_CONFIG)
    : defaultPath;

  let currentFile: VuhlpConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      currentFile = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // ignore
    }
  }

  // Deep merge would be better, but top-level merge is a start. 
  // Actually, let's do a simple merge for the known nested objects to avoid wiping others.
  
  const merge = (target: any, source: any) => {
    for (const key of Object.keys(source)) {
      if (source[key] instanceof Object && !Array.isArray(source[key]) && target[key]) {
        Object.assign(source[key], merge(target[key], source[key]));
      }
    }
    Object.assign(target || {}, source);
    return target;
  };

  // We want to merge updates INTO currentFile.
  // Simple Object.assign for top level sections is safer for now given the structure.
  // e.g. updates.roles should replace currentFile.roles? Or merge?
  // Usually config UIs replace the whole section.
  
  // Let's assume updates contains the full sections that were edited.
  const next = { ...currentFile, ...updates };

  // Special handling for nested partials if needed, but the UI will likely send full objects for sections.

  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf-8");
}
