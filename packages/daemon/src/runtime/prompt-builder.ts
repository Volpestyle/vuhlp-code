import { promises as fs } from "fs";
import path from "path";
import type {
  EdgeState,
  Envelope,
  GlobalMode,
  NodeState,
  PromptArtifacts,
  PromptBlocks,
  UserMessageRecord,
  UUID
} from "@vuhlp/contracts";
import { ConsoleLogger, type Logger } from "@vuhlp/providers";
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
  private readonly logger: Logger;

  constructor(repoRoot: string, systemTemplatesDir?: string, logger?: Logger) {
    this.repoRoot = repoRoot;
    this.systemTemplatesDir = systemTemplatesDir;
    this.logger = logger ?? new ConsoleLogger({ scope: "prompt-builder" });
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
      this.logger.warn(`role template not found: ${repoPath}`, {
        message,
        template: templateName
      });
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
    const caps = input.node.capabilities;
    lines.push(
      `Capabilities: spawnNodes=${caps.spawnNodes}, runCommands=${caps.runCommands}, writeCode=${caps.writeCode}, writeDocs=${caps.writeDocs}, delegateOnly=${caps.delegateOnly}`
    );
    const perms = input.node.permissions;
    lines.push(
      `Permissions: cliPermissionsMode=${perms.cliPermissionsMode}, agentManagementRequiresApproval=${perms.agentManagementRequiresApproval}`
    );
    lines.push("");
    lines.push("Known nodes:");
    lines.push(...this.formatNodeRoster(input.run.nodes));
    lines.push("");
    lines.push("Known edges:");
    lines.push(...this.formatEdgeRoster(input.run.edges, input.run.nodes));
    lines.push("");
    lines.push("Incoming messages:");
    lines.push(...this.formatMessages(input.messages));
    lines.push("");
    lines.push("Incoming handoffs:");
    lines.push(...this.formatEnvelopes(input.envelopes));
    return lines.join("\n");
  }

  private formatNodeRoster(nodes: Record<UUID, NodeState>): string[] {
    const entries = Object.values(nodes);
    if (entries.length === 0) {
      return ["- none"];
    }
    const sorted = [...entries].sort((left, right) => {
      const labelCompare = left.label.localeCompare(right.label);
      if (labelCompare !== 0) {
        return labelCompare;
      }
      return left.id.localeCompare(right.id);
    });
    return sorted.map((node) => {
      const caps = node.capabilities;
      const alias = node.alias ? ` alias=${node.alias}` : "";
      return `- ${node.label} (${node.id})${alias} role=${node.roleTemplate} provider=${node.provider} status=${node.status} spawnNodes=${caps.spawnNodes}`;
    });
  }

  private formatEdgeRoster(edges: Record<UUID, EdgeState>, nodes: Record<UUID, NodeState>): string[] {
    const entries = Object.values(edges);
    if (entries.length === 0) {
      return ["- none"];
    }
    const sorted = [...entries].sort((left, right) => {
      const leftKey = `${left.from}-${left.to}-${left.label}`;
      const rightKey = `${right.from}-${right.to}-${right.label}`;
      return leftKey.localeCompare(rightKey);
    });
    return sorted.map((edge) => {
      const fromLabel = nodes[edge.from]?.label ?? "unknown";
      const toLabel = nodes[edge.to]?.label ?? "unknown";
      return `- ${fromLabel} (${edge.from}) -> ${toLabel} (${edge.to}) type=${edge.type} bidirectional=${edge.bidirectional} label=${edge.label}`;
    });
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
      if (envelope.payload.response) {
        const replyTo = envelope.payload.response.replyTo ? ` replyTo=${envelope.payload.response.replyTo}` : "";
        lines.push(`  response: ${envelope.payload.response.expectation}${replyTo}`);
      }
      if (envelope.contextRef) {
        lines.push(`  context: ${envelope.contextRef}`);
      }
    }
    return lines;
  }
}
