import fs from "node:fs";
import path from "node:path";
import { ProviderAdapter, ProviderTask, ProviderOutputEvent } from "./types.js";
import { buildCliPrompt, runCliStreaming } from "./cli.js";
import { mapClaudeEvent, clearClaudePendingTools } from "./mappers/index.js";

export interface ClaudeCliConfig {
  kind: "claude-cli";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Include partial messages for streaming (--include-partial-messages) */
  includePartialMessages?: boolean;
  /** Path to CLAUDE.md file to inject. If not specified, will check for workspace CLAUDE.md */
  claudeMdPath?: string;
  /** Whether to inject CLAUDE.md automatically. Default: true */
  injectClaudeMd?: boolean;
}

export class ClaudeCliProvider implements ProviderAdapter {
  id: string;
  displayName: string;
  kind = "claude-cli";
  capabilities = {
    streaming: true,
    structuredOutput: true,
    resumableSessions: true,
  };

  private cfg: ClaudeCliConfig;

  constructor(id: string, cfg: ClaudeCliConfig) {
    this.id = id;
    this.displayName = "Claude Code (CLI)";
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
    clearClaudePendingTools();

    // Build prompt with optional CLAUDE.md injection
    let prompt = buildCliPrompt(task.prompt, task.outputSchemaJson);
    prompt = this.injectClaudeMd(prompt, task.workspacePath);

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

      // For progress events with raw JSON, map through Claude mapper
      if (event.type === "progress" && event.raw) {
        let hasMapping = false;
        for (const mapped of mapClaudeEvent(event.raw)) {
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

  /**
   * Inject CLAUDE.md content at the top of the prompt.
   * This provides Claude with project-specific instructions.
   */
  private injectClaudeMd(prompt: string, workspacePath?: string): string {
    // Skip if injection is disabled
    if (this.cfg.injectClaudeMd === false) {
      return prompt;
    }

    // Find CLAUDE.md file
    const claudeMdPaths: string[] = [];

    // Check configured path first
    if (this.cfg.claudeMdPath) {
      claudeMdPaths.push(this.cfg.claudeMdPath);
    }

    // Check workspace paths
    if (workspacePath) {
      claudeMdPaths.push(
        path.join(workspacePath, "CLAUDE.md"),
        path.join(workspacePath, ".claude", "CLAUDE.md"),
      );
    }

    // Try to read CLAUDE.md from any of the paths
    for (const claudePath of claudeMdPaths) {
      try {
        if (fs.existsSync(claudePath)) {
          const content = fs.readFileSync(claudePath, "utf-8");
          // Inject at the top of the prompt
          return `# Project Instructions (from CLAUDE.md)\n\n${content}\n\n---\n\n${prompt}`;
        }
      } catch {
        // ignore read errors
      }
    }

    return prompt;
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

    // Session support: use --session-id for new sessions, --resume for existing
    if (task.sessionId) {
      args.push("--resume", task.sessionId);
    }

    // Output format for structured parsing
    args.push("--output-format", "stream-json");

    // Include partial messages for streaming deltas
    if (this.cfg.includePartialMessages !== false) {
      args.push("--include-partial-messages");
    }

    // Add the prompt placeholder
    args.push("{prompt}");

    return args;
  }
}
