import { promises as fs } from "fs";
import path from "path";
import type {
  Envelope,
  GlobalMode,
  PromptArtifacts,
  PromptBlocks,
  UserMessageRecord
} from "@vuhlp/contracts";
import type { TurnInput } from "./runner.js";
import { hashString } from "./utils.js";

const SYSTEM_CONTEXT = [
  "You operate inside vuhlp, a local-first graph orchestration system.",
  "Graph-first workflow. Keep actions observable and auditable.",
  "Log tool usage, diffs, and outputs; avoid hidden edits.",
  "Respect Planning vs Implementation mode gates.",
  "Avoid useless loops; report stalls with evidence."
].join("\n");

const MODE_PREAMBLE: Record<GlobalMode, string> = {
  PLANNING: [
    "Mode: PLANNING.",
    "Read-only repo access.",
    "Write access allowed only in docs/.",
    "Ask to switch to Implementation if code changes are needed."
  ].join("\n"),
  IMPLEMENTATION: [
    "Mode: IMPLEMENTATION.",
    "Code edits allowed.",
    "Docs updates allowed.",
    "Run tests or verification commands when appropriate."
  ].join("\n")
};

export interface PromptBuildResult {
  artifacts: PromptArtifacts;
  delta: string;
}

export interface PromptBuildOptions {
  toolProtocol?: string;
}

export class PromptBuilder {
  private readonly repoRoot: string;
  private readonly systemTemplatesDir?: string;
  private readonly templateCache = new Map<string, string>();

  constructor(repoRoot: string, systemTemplatesDir?: string) {
    this.repoRoot = repoRoot;
    this.systemTemplatesDir = systemTemplatesDir;
  }

  async build(input: TurnInput, options: PromptBuildOptions = {}): Promise<PromptBuildResult> {
    const system = [SYSTEM_CONTEXT, options.toolProtocol].filter(Boolean).join("\n\n");
    const role = await this.loadRoleTemplate(input);
    const mode = MODE_PREAMBLE[input.run.globalMode];
    const task = this.buildTaskPayload(input);
    const blocks: PromptBlocks = {
      system,
      role,
      mode,
      task
    };
    const full = [blocks.system, blocks.role, blocks.mode, blocks.task]
      .filter((block) => block.trim().length > 0)
      .join("\n\n");
    const hash = hashString(full);
    const delta = [blocks.mode, blocks.task].filter((block) => block.trim().length > 0).join("\n\n");
    return {
      artifacts: {
        full,
        blocks,
        hash
      },
      delta
    };
  }

  private async loadRoleTemplate(input: TurnInput): Promise<string> {
    if (input.config.customSystemPrompt) {
      return input.config.customSystemPrompt;
    }
    const templateName = input.config.roleTemplate;
    const cached = this.templateCache.get(templateName);
    if (cached) {
      return cached;
    }

    // transform input.config.roleTemplate from "role" to "role.md"
    const fileName = `${templateName}.md`;

    // Try repo root first
    const repoPath = path.resolve(this.repoRoot, "docs", "templates", fileName);
    try {
      const content = await fs.readFile(repoPath, "utf8");
      this.templateCache.set(templateName, content);
      return content;
    } catch (error) {
      // If not found and we have a system dir, try that
      if (this.systemTemplatesDir) {
        const systemPath = path.resolve(this.systemTemplatesDir, fileName);
        try {
          const content = await fs.readFile(systemPath, "utf8");
          this.templateCache.set(templateName, content);
          return content;
        } catch (sysError) {
          // ignore, fall through to error handling
        }
      }

      const message = error instanceof Error ? error.message : String(error);
      console.warn(`role template not found: ${repoPath}`, { message, template: templateName });
      const fallback = `Role template not found: ${templateName}`;
      this.templateCache.set(templateName, fallback);
      return fallback;
    }
  }

  private buildTaskPayload(input: TurnInput): string {
    const lines: string[] = [];
    lines.push("Task Payload");
    lines.push(`Run: ${input.run.id}`);
    lines.push(`Node: ${input.node.label} (${input.node.id})`);
    lines.push(`Role: ${input.node.roleTemplate}`);
    lines.push(`Provider: ${input.node.provider}`);
    lines.push(`Orchestration: ${input.run.mode}`);
    lines.push(`Global mode: ${input.run.globalMode}`);
    lines.push("");
    lines.push("Incoming messages:");
    lines.push(...this.formatMessages(input.messages));
    lines.push("");
    lines.push("Incoming handoffs:");
    lines.push(...this.formatEnvelopes(input.envelopes));
    return lines.join("\n");
  }

  private formatMessages(messages: UserMessageRecord[]): string[] {
    if (messages.length === 0) {
      return ["- none"];
    }
    return messages.map((message) => {
      const interrupt = message.interrupt ? "interrupt" : "queue";
      return `- [${message.role}] (${interrupt}) ${message.content}`;
    });
  }

  private formatEnvelopes(envelopes: Envelope[]): string[] {
    if (envelopes.length === 0) {
      return ["- none"];
    }
    const lines: string[] = [];
    for (const envelope of envelopes) {
      lines.push(`- from ${envelope.fromNodeId}: ${envelope.payload.message}`);
      if (envelope.payload.structured) {
        lines.push(`  structured: ${JSON.stringify(envelope.payload.structured)}`);
      }
      if (envelope.payload.artifacts && envelope.payload.artifacts.length > 0) {
        const refs = envelope.payload.artifacts.map((artifact) => artifact.ref).join(", ");
        lines.push(`  artifacts: ${refs}`);
      }
      if (envelope.payload.status) {
        const status = envelope.payload.status.ok ? "ok" : "failed";
        const reason = envelope.payload.status.reason ? ` (${envelope.payload.status.reason})` : "";
        lines.push(`  status: ${status}${reason}`);
      }
      if (envelope.contextRef) {
        lines.push(`  context: ${envelope.contextRef}`);
      }
    }
    return lines;
  }
}
