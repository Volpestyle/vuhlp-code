/**
 * Provider specification resolver
 *
 * Resolves provider configuration from environment variables
 * and applies provider-specific defaults for CLI streaming.
 */

import fs from "node:fs";
import path from "node:path";
import type { ProviderName } from "@vuhlp/contracts";
import type { Logger, NativeToolHandling, ProviderProtocol } from "@vuhlp/providers";

export interface ProviderSpec {
  transport: "cli" | "api";
  command?: string;
  args?: string[];
  protocol?: ProviderProtocol;
  statefulStreaming?: boolean;
  resumeArgs?: string[];
  replayTurns?: number;
  apiKey?: string;
  apiBaseUrl?: string;
  model?: string;
  maxTokens?: number;
  nativeToolHandling?: NativeToolHandling;
}

export interface ProviderResolverOptions {
  appRoot: string;
  logger: Logger;
}

export class ProviderResolver {
  private readonly appRoot: string;
  private readonly logger: Logger;

  constructor(options: ProviderResolverOptions) {
    this.appRoot = options.appRoot;
    this.logger = options.logger;
  }

  resolve(provider: ProviderName): ProviderSpec | null {
    const prefix = provider.toUpperCase();
    const transportEnv = this.readEnv(`VUHLP_${prefix}_TRANSPORT`);
    const transport = transportEnv?.toLowerCase() === "api" ? "api" : "cli";
    const statefulDefault = true;
    const statefulStreamingRaw = this.readEnv(`VUHLP_${prefix}_STATEFUL_STREAMING`);
    let statefulStreaming = this.readEnvFlag(
      `VUHLP_${prefix}_STATEFUL_STREAMING`,
      statefulDefault
    );
    const resumeArgsRaw = this.parseArgs(this.readEnv(`VUHLP_${prefix}_RESUME_ARGS`));
    let resumeArgs = resumeArgsRaw.length > 0 ? resumeArgsRaw : [];
    const replayTurnsRaw = this.readEnv(`VUHLP_${prefix}_REPLAY_TURNS`);
    let replayTurns = statefulStreaming ? 4 : 0;
    if (replayTurnsRaw) {
      const parsed = Number(replayTurnsRaw);
      replayTurns = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    }
    const nativeToolHandling = this.resolveNativeToolHandling(
      provider,
      this.readEnv(`VUHLP_${prefix}_NATIVE_TOOLS`)
    );

    if (transport === "api") {
      const apiKey = this.readEnv(`VUHLP_${prefix}_API_KEY`);
      const model = this.readEnv(`VUHLP_${prefix}_MODEL`);
      if (apiKey && model) {
        const apiBaseUrl = this.readEnv(`VUHLP_${prefix}_API_URL`);
        const maxTokensRaw = this.readEnv(`VUHLP_${prefix}_MAX_TOKENS`);
        const maxTokens = maxTokensRaw ? Number(maxTokensRaw) : undefined;
        return this.applyStreamingDefaults(provider, {
          transport: "api",
          apiKey,
          apiBaseUrl,
          model,
          maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
          nativeToolHandling
        });
      }
      this.logger.warn("api transport requested but missing credentials, falling back to CLI", {
        provider,
        hasApiKey: Boolean(apiKey),
        hasModel: Boolean(model)
      });
    }

    const explicitCommand = this.readEnv(`VUHLP_${prefix}_COMMAND`);
    let command = explicitCommand ?? provider;
    if (provider === "claude" && !explicitCommand) {
      const localBinary = this.resolveLocalClaudeBinary();
      if (localBinary) {
        command = localBinary.path;
        this.logger.info("using local Claude CLI binary", {
          provider,
          path: localBinary.path,
          source: localBinary.source
        });
      } else {
        this.logger.error("Claude CLI not found; set VUHLP_CLAUDE_COMMAND or install claude", {
          provider,
          command,
          nodeExecPath: process.execPath
        });
      }
    }
    if (provider === "codex" && !explicitCommand) {
      const localBinary = this.resolveLocalCodexBinary();
      if (localBinary) {
        command = localBinary.path;
        this.logger.info("using local Codex CLI binary", {
          provider,
          path: localBinary.path,
          source: localBinary.source
        });
      } else {
        const repoPath = this.resolveLocalCodexRepo();
        if (repoPath) {
          const candidates = this.getLocalCodexBinaryCandidates(repoPath);
          this.logger.error("local Codex repo found but CLI binary missing", {
            provider,
            repoPath,
            expectedRelease: candidates.release,
            expectedDebug: candidates.debug,
            hint: "Build with `cargo build -p codex-cli` from packages/providers/codex"
          });
        } else {
          const expectedRepo = path.join(this.resolveProvidersRoot(), "codex");
          this.logger.error(
            "local Codex repo not found; Codex CLI requires the packages/providers/codex fork",
            {
              provider,
              expectedRepo,
              hint: "Clone https://github.com/openai/codex into packages/providers/codex"
            }
          );
        }
        return null;
      }
    }

    if (provider === "gemini" && !explicitCommand) {
      const localBinary = this.resolveLocalGeminiBinary();
      if (localBinary) {
        command = localBinary.path;
        this.logger.info("using local Gemini CLI bundle", {
          provider,
          path: localBinary.path
        });
      } else {
        const repoPath = this.resolveLocalGeminiRepo();
        if (repoPath) {
          const expectedBundle = path.join(repoPath, "bundle", "gemini.js");
          this.logger.error("local Gemini repo found but bundle missing", {
            provider,
            repoPath,
            expectedBundle,
            hint: "Run `npm run bundle` from packages/providers/gemini-cli"
          });
        }
        // If we don't find a local repo, we fall back to "gemini" globally, 
        // which will likely fail but matches standard behavior.
      }
    }

    const args = this.parseArgs(this.readEnv(`VUHLP_${prefix}_ARGS`));
    const protocolRaw = this.readEnv(`VUHLP_${prefix}_PROTOCOL`);
    let protocol = this.parseProtocol(protocolRaw);

    if (provider === "claude") {
      if (protocolRaw) {
        this.logger.warn("Claude CLI protocol overrides are ignored; using stream-json", {
          provider,
          protocol: protocolRaw
        });
      }
      if (statefulStreamingRaw) {
        this.logger.warn("Claude CLI stateful streaming overrides are ignored; always stateful", {
          provider,
          value: statefulStreamingRaw
        });
      }
      if (resumeArgsRaw.length > 0) {
        this.logger.warn("Claude CLI resume args are ignored in stream-json stdin mode", {
          provider,
          resumeArgs: resumeArgsRaw
        });
      }
      protocol = "stream-json";
      statefulStreaming = true;
      resumeArgs = [];
      if (!replayTurnsRaw) {
        replayTurns = 4;
      }
    }

    if (provider === "codex") {
      if (protocolRaw) {
        this.logger.warn("Codex CLI protocol overrides are ignored; using jsonl", {
          provider,
          protocol: protocolRaw
        });
      }
      if (statefulStreamingRaw) {
        this.logger.warn("Codex CLI stateful streaming overrides are ignored; always stateful", {
          provider,
          value: statefulStreamingRaw
        });
      }
      if (resumeArgsRaw.length > 0) {
        this.logger.warn("Codex CLI resume args are ignored in jsonl stdin mode", {
          provider,
          resumeArgs: resumeArgsRaw
        });
      }
      protocol = "jsonl";
      statefulStreaming = true;
      resumeArgs = [];
      if (!replayTurnsRaw) {
        replayTurns = 4;
      }
    }

    if (provider === "custom" && !explicitCommand) {
      return null;
    }

    return this.applyStreamingDefaults(provider, {
      transport: "cli",
      command,
      args,
      protocol,
      statefulStreaming,
      resumeArgs,
      replayTurns,
      nativeToolHandling
    });
  }

  private resolveProvidersRoot(): string {
    return path.join(this.appRoot, "packages", "providers");
  }

  private resolveLocalCodexRepo(): string | null {
    const repoPath = path.join(this.resolveProvidersRoot(), "codex");
    if (!fs.existsSync(repoPath)) {
      return null;
    }
    try {
      const stats = fs.statSync(repoPath);
      return stats.isDirectory() ? repoPath : null;
    } catch {
      return null;
    }
  }

  private getLocalCodexBinaryCandidates(repoPath: string): { release: string; debug: string } {
    return {
      release: path.join(repoPath, "target", "release", "codex"),
      debug: path.join(repoPath, "target", "debug", "codex")
    };
  }

  private resolveLocalCodexBinary(): { path: string; source: "release" | "debug" } | null {
    const repoPath = this.resolveLocalCodexRepo();
    if (!repoPath) {
      return null;
    }
    const candidates = this.getLocalCodexBinaryCandidates(repoPath);
    if (this.isExecutableFile(candidates.release)) {
      return { path: candidates.release, source: "release" };
    }
    if (this.isExecutableFile(candidates.debug)) {
      return { path: candidates.debug, source: "debug" };
    }
    return null;
  }

  private isExecutableFile(candidate: string): boolean {
    if (!fs.existsSync(candidate)) {
      return false;
    }
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }

  readEnv(name: string): string | undefined {
    const value = process.env[name];
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private resolveNativeToolHandling(
    provider: ProviderName,
    value?: string
  ): NativeToolHandling {
    if (provider === "claude" || provider === "codex" || provider === "gemini") {
      if (value) {
        this.logger.warn("native tool handling override ignored for provider", {
          provider,
          value
        });
      }
      return "provider";
    }
    if (value) {
      const normalized = value.trim().toLowerCase();
      if (normalized === "provider") {
        return "provider";
      }
      if (normalized === "vuhlp") {
        return "vuhlp";
      }
      this.logger.warn("unknown native tool handling mode; using default", {
        provider,
        value
      });
    }
    return "vuhlp";
  }

  readEnvFlag(name: string, defaultValue = false): boolean {
    const value = this.readEnv(name);
    if (!value) {
      return defaultValue;
    }
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }

  private parseArgs(raw?: string): string[] {
    if (!raw) {
      return [];
    }
    return raw.split(/\s+/).filter((value) => value.length > 0);
  }

  private parseProtocol(raw?: string): ProviderProtocol | undefined {
    if (!raw) {
      return undefined;
    }
    if (raw === "raw") {
      return "raw";
    }
    if (raw === "stream-json") {
      return "stream-json";
    }
    if (raw === "jsonl") {
      return "jsonl";
    }
    return "jsonl";
  }

  applyStreamingDefaults(provider: ProviderName, spec: ProviderSpec): ProviderSpec {
    if (spec.transport !== "cli") {
      return spec;
    }

    const commandRaw = spec.command ?? provider;
    const command = commandRaw.toLowerCase();
    const args = [...(spec.args ?? [])];

    if (provider === "claude" && command.includes("claude")) {
      const hasPrint = args.includes("--print");
      const hasOutputFormat =
        args.some((arg) => arg === "--output-format" || arg.startsWith("--output-format="));
      const outputFormatValue = this.getCliOptionValue(args, "--output-format");
      const hasInputFormat =
        args.some((arg) => arg === "--input-format" || arg.startsWith("--input-format="));
      const inputFormatValue = this.getCliOptionValue(args, "--input-format");
      const hasPartialMessages = args.includes("--include-partial-messages");
      const shouldWarnProtocol = spec.protocol && spec.protocol !== "stream-json";

      if (!hasPrint) {
        args.push("--print");
      }
      if (!hasOutputFormat) {
        args.push("--output-format", "stream-json");
      } else if (outputFormatValue && outputFormatValue !== "stream-json") {
        this.logger.warn("Claude CLI output format is not stream-json; overriding to stream-json", {
          provider,
          outputFormat: outputFormatValue
        });
        args.push("--output-format", "stream-json");
      }
      if (!hasPartialMessages) {
        args.push("--include-partial-messages");
      }
      if (!hasInputFormat) {
        args.push("--input-format", "stream-json");
      } else if (inputFormatValue && inputFormatValue !== "stream-json") {
        this.logger.warn("Claude CLI input format is not stream-json; overriding to stream-json", {
          provider,
          inputFormat: inputFormatValue
        });
        args.push("--input-format", "stream-json");
      }
      if (shouldWarnProtocol) {
        this.logger.warn("Claude CLI protocol overridden to stream-json for streaming enforcement", {
          provider,
          protocol: spec.protocol
        });
      }

      return {
        ...spec,
        command: spec.command ?? provider,
        args,
        protocol: "stream-json"
      };
    }

    if (provider === "codex" && command.includes("codex")) {
      const hasVuhlpCommand = args[0] === "vuhlp";
      if (!hasVuhlpCommand) {
        if (args.length > 0) {
          this.logger.warn("Codex CLI args overridden to use vuhlp jsonl mode", {
            provider,
            args
          });
        }
        args.length = 0;
        args.push("vuhlp");
      }
      const shouldWarnProtocol = spec.protocol && spec.protocol !== "jsonl";
      if (shouldWarnProtocol) {
        this.logger.warn("Codex CLI protocol overridden to jsonl for vuhlp mode", {
          provider,
          protocol: spec.protocol
        });
      }
      return {
        ...spec,
        command: spec.command ?? provider,
        args,
        protocol: "jsonl"
      };
    }

    if (provider === "gemini" && this.isGeminiCommand(commandRaw, args)) {
      const hasInputFormat =
        args.some((arg) => arg === "--input-format" || arg.startsWith("--input-format="));
      const inputFormatValue = this.getCliOptionValue(args, "--input-format");
      const hasOutputFormat =
        args.some((arg) => arg === "--output-format" || arg.startsWith("--output-format="));
      const outputFormatValue = this.getCliOptionValue(args, "--output-format");
      const shouldWarnProtocol = spec.protocol && spec.protocol !== "stream-json";

      if (!hasInputFormat) {
        args.push("--input-format", "stream-json");
      } else if (inputFormatValue && inputFormatValue !== "stream-json") {
        this.logger.warn("Gemini CLI input format is not stream-json; streaming may be disabled", {
          provider,
          inputFormat: inputFormatValue
        });
      }
      if (!hasOutputFormat) {
        args.push("--output-format", "stream-json");
      } else if (outputFormatValue && outputFormatValue !== "stream-json") {
        this.logger.warn("Gemini CLI output format is not stream-json; streaming may be disabled", {
          provider,
          outputFormat: outputFormatValue
        });
      }
      if (shouldWarnProtocol) {
        this.logger.warn("Gemini CLI protocol overridden to stream-json for streaming enforcement", {
          provider,
          protocol: spec.protocol
        });
      }

      return {
        ...spec,
        command: spec.command ?? provider,
        args,
        protocol: "stream-json"
      };
    }

    return spec;
  }

  private isGeminiCommand(command: string, args: string[]): boolean {
    const normalizedCommand = command.toLowerCase();
    if (normalizedCommand.includes("gemini")) {
      return true;
    }
    for (const arg of args) {
      if (arg.toLowerCase().includes("gemini")) {
        return true;
      }
    }
    return false;
  }

  getCliOptionValue(args: string[], option: string): string | null {
    for (let i = 0; i < args.length; i += 1) {
      const value = args[i];
      if (value === option) {
        return args[i + 1] ?? null;
      }
      if (value.startsWith(`${option}=`)) {
        return value.slice(option.length + 1);
      }
    }
    return null;
  }

  private resolveLocalGeminiRepo(): string | null {
    const repoPath = path.join(this.resolveProvidersRoot(), "gemini-cli");
    if (!fs.existsSync(repoPath)) {
      return null;
    }
    try {
      const stats = fs.statSync(repoPath);
      return stats.isDirectory() ? repoPath : null;
    } catch {
      return null;
    }
  }

  private resolveLocalGeminiBinary(): { path: string } | null {
    const repoPath = this.resolveLocalGeminiRepo();
    if (!repoPath) {
      return null;
    }
    const bundlePath = path.join(repoPath, "bundle", "gemini.js");
    if (this.isExecutableFile(bundlePath)) {
      return { path: bundlePath };
    }
    return null;
  }

  private resolveLocalClaudeBinary(): { path: string; source: "node-bin" | "path" } | null {
    const nodeBin = path.join(path.dirname(process.execPath), "claude");
    if (this.isExecutableFile(nodeBin)) {
      return { path: nodeBin, source: "node-bin" };
    }
    const pathBinary = this.resolveCommandFromPath("claude");
    if (pathBinary) {
      return { path: pathBinary, source: "path" };
    }
    return null;
  }

  private resolveCommandFromPath(command: string): string | null {
    if (path.isAbsolute(command)) {
      return this.isExecutableFile(command) ? command : null;
    }
    const pathEnv = this.readEnv("PATH");
    if (!pathEnv) {
      return null;
    }
    const extensions = this.getPathExtensions();
    const entries = pathEnv.split(path.delimiter).filter((entry) => entry.length > 0);
    for (const entry of entries) {
      for (const ext of extensions) {
        const candidate = path.join(entry, `${command}${ext}`);
        if (this.isExecutableFile(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  }

  private getPathExtensions(): string[] {
    if (process.platform !== "win32") {
      return [""];
    }
    const pathExt = this.readEnv("PATHEXT");
    if (!pathExt) {
      return [""];
    }
    return pathExt
      .split(";")
      .map((ext) => ext.trim())
      .filter((ext) => ext.length > 0);
  }
}
