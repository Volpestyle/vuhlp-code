import fs from "node:fs";
import path from "node:path";
import { ProviderAdapter, ProviderTask, ProviderOutputEvent } from "./types.js";
import { buildCliPrompt, runCliStreaming, StdinWriter } from "./cli.js";
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
  /** Active stdin writers keyed by nodeId for bidirectional communication */
  private stdinWriters = new Map<string, StdinWriter>();

  constructor(id: string, cfg: ClaudeCliConfig) {
    this.id = id;
    this.displayName = "Claude Code (CLI)";
    this.cfg = cfg;
  }

  /**
   * Send an approval response to the CLI process for a specific node.
   * Used in INTERACTIVE mode to approve/deny tool calls.
   */
  sendApprovalResponse(nodeId: string, toolUseId: string, approved: boolean, modifiedArgs?: Record<string, unknown>): boolean {
    const writer = this.stdinWriters.get(nodeId);
    if (!writer) {
      return false;
    }

    // Format the tool_result message for Claude CLI stream-json input
    const response = {
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: approved ? (modifiedArgs ? JSON.stringify(modifiedArgs) : "approved") : "denied",
          is_error: !approved,
        }],
      },
    };

    return writer(JSON.stringify(response));
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

    // Use bidirectional mode when not skipping permissions (INTERACTIVE mode)
    const useBidirectional = !task.skipPermissions;

    try {
      for await (const event of runCliStreaming(
        {
          command: this.cfg.command,
          args,
          env: this.cfg.env,
          cwd: task.workspacePath,
          prompt,
          emitConsoleChunks: true,
          keepStdinOpen: useBidirectional,
          onStdinReady: useBidirectional
            ? (writer) => this.stdinWriters.set(task.nodeId, writer)
            : undefined,
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
    } finally {
      // Cleanup stdin writer when task completes
      this.stdinWriters.delete(task.nodeId);
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
    // Use custom args if provided, but handle skipPermissions and session dynamically
    if (this.cfg.args?.length) {
      // Start with config args
      const baseArgs = [...this.cfg.args];

      // Ensure we don't have conflicting permissions flags if we need to force one
      // But usually we just append what's needed if missing.

      // 1. Handle Permissions / Bidirectional Mode
      const hasSkip = baseArgs.includes("--dangerously-skip-permissions");
      if (task.skipPermissions) {
        if (!hasSkip) baseArgs.push("--dangerously-skip-permissions");
      } else {
        // INTERACTIVE mode needs stream-json input
        if (!baseArgs.includes("--input-format")) {
          baseArgs.push("--input-format", "stream-json");
        }
      }

      // 2. Handle Session Resumption (CRITICAL FIX)
      if (task.sessionId && !baseArgs.includes("--resume")) {
        baseArgs.push("--resume", task.sessionId);
      }

      // 3. Handle Output Format (CRITICAL for parsing)
      if (!baseArgs.includes("--output-format")) {
        baseArgs.push("--output-format", "stream-json");
      }

      // 4. Handle Partial Messages (CRITICAL for streaming)
      if (this.cfg.includePartialMessages !== false && !baseArgs.includes("--include-partial-messages")) {
        baseArgs.push("--include-partial-messages");
      }

      return baseArgs.map((a) =>
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

    // Skip permissions in AUTO mode, otherwise use bidirectional streaming
    if (task.skipPermissions) {
      args.push("--dangerously-skip-permissions");
    } else {
      // INTERACTIVE mode: add input-format for bidirectional streaming
      args.push("--input-format", "stream-json");
    }

    // Add the prompt placeholder
    args.push("{prompt}");

    return args;
  }
}
