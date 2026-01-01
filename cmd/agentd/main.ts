#!/usr/bin/env bun
import { createKit, ModelRouter, Provider } from "@volpestyle/ai-kit-node";
import { Store } from "../../internal/runstore";
import { defaultConfig, expandHome, loadFromFile } from "../../internal/config";
import { loadSettings } from "../../internal/config/settings";
import { loadEnvFile } from "../../internal/util/env";
import { Runner } from "../../internal/agent/runner";
import { SessionRunner } from "../../internal/agent/session_runner";
import { ModelService } from "../../internal/agent/model_service";
import { SpecGenerator } from "../../internal/agent/specgen";
import { Server } from "../../internal/api/server";
import minimist from "minimist";
import path from "node:path";

async function main(): Promise<void> {
  const args = minimist(process.argv.slice(2));
  const flagListen = args.listen ?? "";
  const flagDataDir = args["data-dir"] ?? "";
  const flagAuth = args["auth-token"] ?? "";
  const flagConfig = args.config ?? "";

  await loadEnvFile(".env.local");
  await loadEnvFile(".env");

  let cfg = defaultConfig();

  const configPath = flagConfig || process.env.HARNESS_CONFIG || "";
  if (configPath) {
    try {
      cfg = await loadFromFile(configPath);
    } catch (err) {
      console.warn("failed to load config file", { path: configPath, err });
    }
  }

  if (process.env.HARNESS_LISTEN && !cfg.listen_addr) {
    cfg.listen_addr = process.env.HARNESS_LISTEN;
  }
  if (process.env.HARNESS_DATA_DIR && !cfg.data_dir) {
    cfg.data_dir = process.env.HARNESS_DATA_DIR;
  }
  if (process.env.HARNESS_AUTH_TOKEN && !cfg.auth_token) {
    cfg.auth_token = process.env.HARNESS_AUTH_TOKEN;
  }

  if (flagListen) cfg.listen_addr = flagListen;
  if (flagDataDir) cfg.data_dir = flagDataDir;
  if (flagAuth) cfg.auth_token = flagAuth;

  cfg.data_dir = expandHome(cfg.data_dir);

  const settingsPath = path.join(cfg.data_dir, "settings.json");
  try {
    const { settings, exists } = await loadSettings(settingsPath);
    if (exists) {
      cfg.model_policy = settings.model_policy;
    }
  } catch (err) {
    console.warn("failed to load settings", { path: settingsPath, err });
  }

  const store = new Store(cfg.data_dir);
  await store.init();

  const providers: Record<string, unknown> = {};

  const openAIKey = (process.env.OPENAI_API_KEY ?? "").trim();
  const openAIKeys = parseKeyList(process.env.OPENAI_API_KEYS ?? "");
  if (openAIKey || openAIKeys.length) {
    providers[Provider.OpenAI] = { apiKey: openAIKey || undefined, apiKeys: openAIKeys };
  }
  const anthropicKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  const anthropicKeys = parseKeyList(process.env.ANTHROPIC_API_KEYS ?? "");
  if (anthropicKey || anthropicKeys.length) {
    providers[Provider.Anthropic] = { apiKey: anthropicKey || undefined, apiKeys: anthropicKeys };
  }
  const xaiKey = (process.env.XAI_API_KEY ?? "").trim();
  const xaiKeys = parseKeyList(process.env.XAI_API_KEYS ?? "");
  if (xaiKey || xaiKeys.length) {
    providers[Provider.XAI] = { apiKey: xaiKey || undefined, apiKeys: xaiKeys };
  }
  const googleKey = (process.env.GOOGLE_API_KEY ?? "").trim();
  const googleKeys = parseKeyList(process.env.GOOGLE_API_KEYS ?? "");
  if (googleKey || googleKeys.length) {
    providers[Provider.Google] = { apiKey: googleKey || undefined, apiKeys: googleKeys };
  }
  let ollamaBase = (process.env.OLLAMA_BASE_URL ?? "").trim();
  const ollamaKey = (process.env.OLLAMA_API_KEY ?? "").trim();
  if (ollamaBase || ollamaKey) {
    providers[Provider.Ollama] = { baseURL: ollamaBase || undefined, apiKey: ollamaKey || undefined };
  }

  if (!Object.keys(providers).length) {
    if (!ollamaBase) ollamaBase = "http://localhost:11434";
    providers[Provider.Ollama] = { baseURL: ollamaBase };
    console.info("ai-kit: no provider keys configured; defaulting to Ollama", { base_url: ollamaBase });
  }

  const kit = createKit({
    providers: providers as any,
    registry: { ttlMs: 15 * 60_000 },
  });

  const runner = new Runner(store, kit, cfg.model_policy, new ModelRouter());
  const sessionRunner = new SessionRunner(store, kit, cfg.model_policy, new ModelRouter());
  const modelService = new ModelService(kit, cfg.model_policy, settingsPath, runner, sessionRunner);
  const specGen = new SpecGenerator(kit, cfg.model_policy, new ModelRouter());

  const server = new Server(store, cfg.auth_token, runner, sessionRunner, specGen, modelService);

  const { hostname, port } = parseListenAddr(cfg.listen_addr);
  const bunServer = Bun.serve({
    hostname,
    port,
    fetch: server.handler(),
  });

  console.info("agentd listening", { addr: cfg.listen_addr, data_dir: cfg.data_dir });
  if (cfg.auth_token) {
    console.info("auth enabled", { mode: "bearer" });
  }

  const shutdown = () => {
    console.info("shutting down");
    bunServer.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function parseKeyList(value: string): string[] {
  return value
    .split(/[;,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseListenAddr(addr: string): { hostname: string; port: number } {
  const trimmed = addr.trim() || "127.0.0.1:8787";
  const [host, portRaw] = trimmed.split(":");
  const port = Number(portRaw || "8787");
  return { hostname: host || "127.0.0.1", port: Number.isFinite(port) ? port : 8787 };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
