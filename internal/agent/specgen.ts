import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Kit, ModelRecord } from "@volpestyle/ai-kit-node";
import { ModelRouter } from "@volpestyle/ai-kit-node";
import type { ModelPolicy } from "../config";

export class SpecGenerator {
  constructor(
    private kit: Kit,
    private policy: ModelPolicy,
    private router: ModelRouter = new ModelRouter(),
  ) {}

  async generateSpec(workspacePath: string, specName: string, prompt: string): Promise<string> {
    if (!this.kit) throw new Error("kit is nil");
    const model = await this.resolveModel();
    let agents = "";
    try {
      agents = await readFile(path.join(workspacePath, "AGENTS.md"), "utf8");
    } catch {
      // ignore
    }
    const sys = buildSpecPrompt(specName, prompt, agents);

    const out = await this.kit.generate({
      provider: model.provider,
      model: model.providerModelId,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: sys }],
        },
      ],
    });
    let content = (out.text ?? "").trim();
    if (!content) throw new Error("model returned empty spec");
    if (!content.includes("# Goal")) {
      content = fallbackSpec(specName, prompt);
    }
    if (!content.endsWith("\n")) content += "\n";
    return content;
  }

  private async resolveModel(): Promise<ModelRecord> {
    const records = await this.kit.listModelRecords();
    const resolved = this.router.resolve(records, {
      constraints: {
        requireTools: this.policy.require_tools,
        requireVision: this.policy.require_vision,
        maxCostUsd: this.policy.max_cost_usd,
      },
      preferredModels: this.policy.preferred_models,
    });
    return resolved.primary;
  }
}

function buildSpecPrompt(name: string, prompt: string, agents: string): string {
  let out = "";
  out += "You are an expert product/spec writer for a coding agent harness.\n";
  out += "Return ONLY markdown (no code fences, no commentary).\n";
  out += "Follow this exact structure:\n";
  out += "---\n";
  out += `name: ${name}\n`;
  out += "owner: you\n";
  out += "status: draft\n";
  out += "---\n\n";
  out += "# Goal\n\n";
  out += "<one paragraph goal>\n\n";
  out += "# Constraints / nuances\n\n";
  out += "- <bullets>\n\n";
  out += "# Acceptance tests\n\n";
  out += "- <bulleted, runnable checks>\n\n";
  out += "# Notes\n\n";
  out += "- <optional>\n\n";
  out += "USER PROMPT:\n" + prompt + "\n\n";
  if (agents.trim()) {
    out += "AGENTS.md:\n" + agents + "\n\n";
  }
  return out;
}

function fallbackSpec(name: string, prompt: string): string {
  return `---\nname: ${name}\nowner: you\nstatus: draft\n---\n\n# Goal\n\n${prompt.trim()}\n\n# Constraints / nuances\n\n- Follow repo conventions in AGENTS.md.\n\n# Acceptance tests\n\n- make test\n`;
}
