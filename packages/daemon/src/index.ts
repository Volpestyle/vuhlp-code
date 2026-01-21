import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ConsoleLogger } from "@vuhlp/providers";
import { Runtime } from "./runtime/runtime.js";
import { createServer } from "./api/server.js";

const logger = new ConsoleLogger({ scope: "daemon" });

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex <= 0) {
        continue;
      }
      const key = trimmed.slice(0, equalsIndex).trim();
      if (!key || process.env[key] !== undefined) {
        continue;
      }
      let value = trimmed.slice(equalsIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("failed to load env file", { filePath, message });
  }
}

function findEnvFile(startDir: string, maxDepth = 4): string | null {
  let current = startDir;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = path.resolve(current, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

const envPath = findEnvFile(process.cwd());
if (envPath) {
  loadEnvFile(envPath);
}

const port = Number(process.env.VUHLP_PORT ?? 4000);
const dataDir = process.env.VUHLP_DATA_DIR
  ? path.resolve(process.env.VUHLP_DATA_DIR)
  : path.resolve(process.cwd(), "data");
const repoRoot = process.env.VUHLP_REPO_ROOT
  ? path.resolve(process.env.VUHLP_REPO_ROOT)
  : process.cwd();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const systemTemplatesDir = path.resolve(__dirname, "..", "docs", "templates");
const appRoot = process.env.VUHLP_APP_ROOT
  ? path.resolve(process.env.VUHLP_APP_ROOT)
  : path.resolve(__dirname, "..", "..", "..");

logger.info("resolved runtime paths", { appRoot, repoRoot, dataDir });

const runtime = new Runtime({ dataDir, repoRoot, appRoot, systemTemplatesDir, logger });
const server = createServer(runtime);

const start = async (): Promise<void> => {
  await runtime.start();
  server.listen(port, "0.0.0.0", () => {
    logger.info(`vuhlp daemon listening on http://0.0.0.0:${port}`, { port });
  });
};

void start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("failed to start daemon", { message });
  process.exit(1);
});

let shuttingDown = false;

const closeServer = async (): Promise<void> => {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close((error) => {
      if (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("failed to close server", { message });
      }
      resolve();
    });
  });
};

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info("daemon shutdown requested", { signal });
  try {
    await runtime.shutdown(signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("runtime shutdown failed", { message });
  }
  await closeServer();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
