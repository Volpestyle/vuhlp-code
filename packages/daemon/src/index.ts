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
const dataDir = process.env.VUHLP_DATA_DIR ?? path.resolve(process.cwd(), "data");
const repoRoot = process.env.VUHLP_REPO_ROOT;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const systemTemplatesDir = path.resolve(__dirname, "..", "docs", "templates");

const runtime = new Runtime({ dataDir, repoRoot, systemTemplatesDir, logger });
runtime.start();

const server = createServer(runtime);
server.listen(port, "0.0.0.0", () => {
  logger.info(`vuhlp daemon listening on http://0.0.0.0:${port}`, { port });
});
