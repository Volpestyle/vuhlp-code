import { ProviderAdapter } from "./types.js";
import { MockProvider } from "./mock.js";
import { CodexCliProvider, CodexCliConfig } from "./codexCli.js";
import { ClaudeCliProvider, ClaudeCliConfig } from "./claudeCli.js";
import { GeminiCliProvider, GeminiCliConfig } from "./geminiCli.js";

export type ProviderConfig = { kind: string; [k: string]: any };

export class ProviderRegistry {
  private providers: Map<string, ProviderAdapter> = new Map();

  constructor(configs: Record<string, ProviderConfig>) {
    for (const [id, cfg] of Object.entries(configs ?? {})) {
      const provider = this.create(id, cfg);
      if (provider) this.providers.set(id, provider);
    }
    // Always ensure mock exists.
    if (!this.providers.has("mock")) this.providers.set("mock", new MockProvider());
  }

  get(id: string): ProviderAdapter | null {
    return this.providers.get(id) ?? null;
  }

  list(): ProviderAdapter[] {
    return [...this.providers.values()];
  }

  private create(id: string, cfg: ProviderConfig): ProviderAdapter | null {
    switch (cfg.kind) {
      case "mock":
        return new MockProvider();
      case "codex-cli":
        return new CodexCliProvider(id, cfg as CodexCliConfig);
      case "claude-cli":
        return new ClaudeCliProvider(id, cfg as ClaudeCliConfig);
      case "gemini-cli":
        return new GeminiCliProvider(id, cfg as GeminiCliConfig);
      default:
        return null;
    }
  }
}
