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
