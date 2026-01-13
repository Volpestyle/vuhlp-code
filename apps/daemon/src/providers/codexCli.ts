import fs from "node:fs";
import path from "node:path";
import { ProviderAdapter, ProviderTask, ProviderOutputEvent } from "./types.js";
import { buildCliPrompt, runCliStreaming } from "./cli.js";
import { mapCodexEvent } from "./mappers/index.js";

export interface CodexCliConfig {
  kind: "codex-cli";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Sandbox mode (read-only, read-write, none). Default: read-only */
  sandboxMode?: "read-only" | "read-write" | "none";
  /** Ask for approval setting. Default: never (for custom interface mode) */
  askForApproval?: "always" | "never" | "auto";
  /** Path to AGENTS.md file to inject. If not specified, will check for workspace AGENTS.md */
  agentsMdPath?: string;
  /** Whether to inject AGENTS.md automatically. Default: true */
  injectAgentsMd?: boolean;
}

export class CodexCliProvider implements ProviderAdapter {
  id: string;
  displayName: string;
  kind = "codex-cli";
  capabilities = {
    streaming: true,
    structuredOutput: true,
    resumableSessions: true,
  };

  private cfg: CodexCliConfig;

  constructor(id: string, cfg: CodexCliConfig) {
    this.id = id;
    this.displayName = "Codex (CLI)";
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
    // Build prompt with optional AGENTS.md injection (section 4.1.4)
    let prompt = buildCliPrompt(task.prompt, task.outputSchemaJson);
    prompt = this.injectAgentsMd(prompt, task.workspacePath);

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

      // For progress events with raw JSON, map through Codex mapper
      if (event.type === "progress" && event.raw) {
        let hasMapping = false;
        for (const mapped of mapCodexEvent(event.raw)) {
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
   * Inject AGENTS.md content at the top of the prompt (section 4.1.4).
   * This provides Codex with project-specific instructions.
   */
  private injectAgentsMd(prompt: string, workspacePath?: string): string {
    // Skip if injection is disabled
    if (this.cfg.injectAgentsMd === false) {
      return prompt;
    }

    // Find AGENTS.md file
    const agentsMdPaths: string[] = [];

    // Check configured path first
    if (this.cfg.agentsMdPath) {
      agentsMdPaths.push(this.cfg.agentsMdPath);
    }

    // Check workspace paths
    if (workspacePath) {
      agentsMdPaths.push(
        path.join(workspacePath, "AGENTS.md"),
        path.join(workspacePath, ".github", "AGENTS.md"),
        path.join(workspacePath, "docs", "AGENTS.md"),
      );
    }

    // Try to read AGENTS.md from any of the paths
    for (const agentsPath of agentsMdPaths) {
      try {
        if (fs.existsSync(agentsPath)) {
          const content = fs.readFileSync(agentsPath, "utf-8");
          // Inject at the top of the prompt
          return `# Project Instructions (from AGENTS.md)\n\n${content}\n\n---\n\n${prompt}`;
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
    const args: string[] = ["exec"];

    // Session support: use resume for existing sessions
    if (task.sessionId) {
      args.push("resume", task.sessionId);
    }

    // JSON output for structured parsing
    args.push("--json");

    // Sandbox mode (default: read-only for safety)
    const sandbox = this.cfg.sandboxMode ?? "read-only";
    args.push("--sandbox", sandbox);

    // Disable interactive approval prompts for custom interface mode
    // (vuhlp handles approvals through its own UI)
    const approval = this.cfg.askForApproval ?? "never";
    args.push("--ask-for-approval", approval);

    // Add the prompt (only if not resuming with explicit prompt)
    if (!task.sessionId) {
      args.push("{prompt}");
    } else {
      // For resume, prompt is a follow-up
      args.push("{prompt}");
    }

    return args;
  }
}
