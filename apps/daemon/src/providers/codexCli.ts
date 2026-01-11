import { ProviderAdapter, ProviderTask } from "./types.js";
import { buildCliPrompt, runCliStreaming } from "./cli.js";

export interface CodexCliConfig {
  kind: "codex-cli";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class CodexCliProvider implements ProviderAdapter {
  id: string;
  displayName: string;
  kind = "codex-cli";
  capabilities = {
    streaming: true,
    structuredOutput: true,
    resumableSessions: false,
  };

  private cfg: CodexCliConfig;

  constructor(id: string, cfg: CodexCliConfig) {
    this.id = id;
    this.displayName = "Codex (CLI)";
    this.cfg = cfg;
  }

  async healthCheck() {
    // Best-effort: try spawning `codex --version`.
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
    const args = this.cfg.args?.length ? this.cfg.args : ["exec", "--json", "{prompt}"];
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
