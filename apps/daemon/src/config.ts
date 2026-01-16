import fs from "node:fs";
import path from "node:path";

export interface VuhlpConfig {
  server?: { port?: number };
  dataDir?: string;
  defaultProvider?: string;
  providers?: Record<string, { kind: string } & Record<string, unknown>>;
  roles?: Record<string, string>;
  scheduler?: { maxConcurrency?: number };
  orchestration?: { maxIterations?: number; maxTurnsPerNode?: number; defaultRunMode?: "AUTO" | "INTERACTIVE" };
  planning?: { docsDirectory?: string };
  node_defaults?: { defaultMode?: "auto" | "manual"; maxTurnsPerLoop?: number };
  workspace?: { mode?: "shared" | "worktree" | "copy"; rootDir?: string; cleanupOnDone?: boolean };
  verification?: { commands?: string[] };
  logging?: {
    level?: "debug" | "info" | "warn" | "error";
    dir?: string;
    retentionDays?: string;
  };
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
  cfg.defaultProvider = cfg.defaultProvider ?? "mock";
  cfg.providers = cfg.providers ?? { mock: { kind: "mock" } };
  cfg.roles = cfg.roles ?? {
    investigator: "mock",
    planner: "mock",
    implementer: "mock",
    reviewer: "mock",
  };
  cfg.scheduler = cfg.scheduler ?? { maxConcurrency: 3 };
  cfg.orchestration = cfg.orchestration ?? { maxIterations: 3, maxTurnsPerNode: 2 };
  cfg.orchestration.maxIterations = cfg.orchestration.maxIterations ?? 3;
  cfg.orchestration.maxTurnsPerNode = cfg.orchestration.maxTurnsPerNode ?? 2;
  cfg.orchestration.defaultRunMode = cfg.orchestration.defaultRunMode ?? "INTERACTIVE";

  cfg.planning = cfg.planning ?? {};
  cfg.planning.docsDirectory = cfg.planning.docsDirectory ?? "docs";

  cfg.node_defaults = cfg.node_defaults ?? {};
  cfg.node_defaults.defaultMode = cfg.node_defaults.defaultMode ?? "auto";
  cfg.node_defaults.maxTurnsPerLoop = cfg.node_defaults.maxTurnsPerLoop ?? 10;

  cfg.workspace = cfg.workspace ?? { mode: "shared", rootDir: ".vuhlp/workspaces", cleanupOnDone: false };
  cfg.workspace.mode = cfg.workspace.mode ?? "shared";
  cfg.workspace.rootDir = cfg.workspace.rootDir ?? ".vuhlp/workspaces";
  cfg.workspace.cleanupOnDone = cfg.workspace.cleanupOnDone ?? false;
  cfg.verification = cfg.verification ?? { commands: [] };

  cfg.logging = cfg.logging ?? {};
  cfg.logging.level = cfg.logging.level ?? "info";
  cfg.logging.dir = cfg.logging.dir ?? "logs";
  cfg.logging.retentionDays = cfg.logging.retentionDays ?? "14d";

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

  const merge = (target: any, source: any) => {
    for (const key of Object.keys(source)) {
      if (source[key] instanceof Object && !Array.isArray(source[key]) && target[key]) {
        Object.assign(source[key], merge(target[key], source[key]));
      }
    }
    Object.assign(target || {}, source);
    return target;
  };

  const next = { ...currentFile, ...updates };

  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf-8");
}
