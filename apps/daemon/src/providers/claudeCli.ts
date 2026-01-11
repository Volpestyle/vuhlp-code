import { ProviderAdapter, ProviderTask } from "./types.js";
import { buildCliPrompt, runCliStreaming } from "./cli.js";

export interface ClaudeCliConfig {
  kind: "claude-cli";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class ClaudeCliProvider implements ProviderAdapter {
  id: string;
  displayName: string;
  kind = "claude-cli";
  capabilities = {
    streaming: true,
    structuredOutput: true,
    resumableSessions: false,
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
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) };
    }
  }

  async *runTask(task: ProviderTask, signal: AbortSignal) {
    const prompt = buildCliPrompt(task.prompt, task.outputSchemaJson);
    // Best-effort defaults; user can override in config.
    const args = this.cfg.args?.length
      ? this.cfg.args
      : ["-p", "{prompt}", "--output-format", "stream-json"];
    yield* runCliStreaming(
      {
        command: this.cfg.command,
        args,
        env: this.cfg.env,
        cwd: task.workspacePath,
        prompt,
      },
      signal
    );
  }
}
