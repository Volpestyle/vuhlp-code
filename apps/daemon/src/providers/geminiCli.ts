import { ProviderAdapter, ProviderTask, ProviderOutputEvent } from "./types.js";
import { buildCliPrompt, runCliStreaming } from "./cli.js";
import { mapGeminiEvent, clearGeminiPendingTools } from "./mappers/index.js";

export interface GeminiCliConfig {
  kind: "gemini-cli";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Approval mode for tool execution. Default: auto */
  approvalMode?: "always" | "never" | "auto";
  /** Allowed tools (comma-separated list). Empty means all allowed. */
  allowedTools?: string;
}

export class GeminiCliProvider implements ProviderAdapter {
  id: string;
  displayName: string;
  kind = "gemini-cli";
  capabilities = {
    streaming: true,
    structuredOutput: true,
    resumableSessions: true,
  };

  private cfg: GeminiCliConfig;

  constructor(id: string, cfg: GeminiCliConfig) {
    this.id = id;
    this.displayName = "Gemini (CLI)";
    this.cfg = cfg;
  }

  async healthCheck() {
    try {
      const { spawnSync } = await import("node:child_process");
      const res = spawnSync(this.cfg.command, ["--version"], { encoding: "utf-8" });
      if (res.error) return { ok: false, message: String(res.error) };
      return { ok: res.status === 0, message: res.stdout.trim() || res.stderr.trim() };
    } catch (e: unknown) {
      const err = e as Error;
      return { ok: false, message: err?.message ?? String(e) };
    }
  }

  async *runTask(task: ProviderTask, signal: AbortSignal): AsyncIterable<ProviderOutputEvent> {
    // Clear pending tools tracking from previous runs
    clearGeminiPendingTools();

    const prompt = buildCliPrompt(task.prompt, task.outputSchemaJson);

    // Build args with session support
    const args = this.buildArgs(task, prompt);

    for await (const event of runCliStreaming(
      {
        command: this.cfg.command,
        args,
        env: this.cfg.env,
        cwd: task.workspacePath,
        prompt,
        emitConsoleChunks: true,
      },
      signal
    )) {
      // Pass through console, log, diff, and final events
      if (
        event.type === "console" ||
        event.type === "log" ||
        event.type === "diff" ||
        event.type === "final"
      ) {
        yield event;
        continue;
      }

      // For progress events with raw JSON, map through Gemini mapper
      if (event.type === "progress" && event.raw) {
        let hasMapping = false;
        for (const mapped of mapGeminiEvent(event.raw)) {
          hasMapping = true;
          yield mapped;
        }
        // If mapper didn't produce anything, yield the original progress
        if (!hasMapping) {
          yield event;
        }
      } else {
        // Pass through other events
        yield event;
      }
    }
  }

  private buildArgs(task: ProviderTask, prompt: string): string[] {
    // Use custom args if provided
    if (this.cfg.args?.length) {
      return this.cfg.args.map((a) =>
        a.includes("{prompt}") ? a.replaceAll("{prompt}", prompt) : a
      );
    }

    // Build default args with best practices for custom interface mode
    const args: string[] = ["-p"];

    // Session support: use --resume for existing sessions
    if (task.sessionId) {
      args.push("--resume", task.sessionId);
    }

    // Output format for structured parsing (stream-json for real-time events)
    args.push("--output-format", "stream-json");

    // Approval mode (default: auto, but can be configured)
    if (this.cfg.approvalMode) {
      args.push("--approval-mode", this.cfg.approvalMode);
    }

    // Allowed tools (if specified)
    if (this.cfg.allowedTools) {
      args.push("--allowed-tools", this.cfg.allowedTools);
    }

    // Add the prompt placeholder
    args.push("{prompt}");

    return args;
  }
}
