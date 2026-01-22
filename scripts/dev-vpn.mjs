import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

const loadEnvFile = (filePath, targetEnv) => {
  if (!existsSync(filePath)) {
    return;
  }
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    if (!key || targetEnv[key] !== undefined) {
      continue;
    }
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    targetEnv[key] = value;
  }
};

const parseApiUrl = (apiUrlRaw) => {
  if (!apiUrlRaw) {
    return null;
  }
  try {
    const url = new URL(apiUrlRaw);
    const port = url.port ? Number(url.port) : null;
    return {
      host: url.hostname,
      port: Number.isFinite(port) ? port : null,
      protocol: url.protocol,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dev:vpn] invalid EXPO_PUBLIC_API_URL "${apiUrlRaw}": ${message}`);
    return null;
  }
};

const resolveBindHost = (env) => {
  const candidates = [
    { key: "VUHLP_BIND_HOST", value: env.VUHLP_BIND_HOST },
    { key: "VUHLP_HOST", value: env.VUHLP_HOST },
    { key: "VUHLP_TAILSCALE_IP", value: env.VUHLP_TAILSCALE_IP },
    { key: "TAILSCALE_IP", value: env.TAILSCALE_IP },
  ];

  for (const candidate of candidates) {
    if (typeof candidate.value === "string") {
      const trimmed = candidate.value.trim();
      if (trimmed.length > 0) {
        return { host: trimmed, source: candidate.key };
      }
    }
  }

  const apiUrl = parseApiUrl(env.EXPO_PUBLIC_API_URL);
  if (apiUrl?.host) {
    return { host: apiUrl.host, port: apiUrl.port, source: "EXPO_PUBLIC_API_URL" };
  }

  return null;
};

const env = { ...process.env };
loadEnvFile(path.join(repoRoot, ".env"), env);
loadEnvFile(path.join(repoRoot, "packages", "mobile", ".env"), env);

const resolved = resolveBindHost(env);
if (!resolved) {
  console.error(
    "[dev:vpn] missing tailscale host. Set VUHLP_BIND_HOST or VUHLP_TAILSCALE_IP, or define EXPO_PUBLIC_API_URL in packages/mobile/.env."
  );
  process.exit(1);
}

if (!env.VUHLP_PORT && resolved.port) {
  env.VUHLP_PORT = String(resolved.port);
}

env.VUHLP_BIND_HOST = resolved.host;

const port = env.VUHLP_PORT ?? "4000";
console.log(`[dev:vpn] starting daemon on ${resolved.host}:${port} (from ${resolved.source})`);

const child = spawn("pnpm", ["dev"], {
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[dev:vpn] failed to start pnpm dev: ${message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
