import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { MessagePart } from "../runstore/session_models";
import type { Tool, ToolCall, ToolDefinition, ToolResult } from "./tools";

export class SpecReadTool implements Tool {
  constructor(private specPath: string) {}

  definition(): ToolDefinition {
    return {
      name: "read_spec",
      description: "Read the current spec.md content.",
      kind: "read",
      parameters: { type: "object", properties: {} },
    };
  }

  async invoke(call: ToolCall): Promise<ToolResult> {
    try {
      const content = await readFile(this.specPath, "utf8");
      return { id: call.id, ok: true, parts: [{ type: "text", text: content }] };
    } catch (err: unknown) {
      return {
        id: call.id,
        ok: false,
        error: (err as Error).message,
        parts: [{ type: "text", text: "spec not found" }],
      };
    }
  }
}

export class SpecWriteTool implements Tool {
  constructor(private specPath: string) {}

  definition(): ToolDefinition {
    return {
      name: "write_spec",
      description: "Overwrite spec.md with full content.",
      kind: "write",
      allowWithoutApproval: true,
      parameters: {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        required: ["content"],
      },
    };
  }

  async invoke(call: ToolCall): Promise<ToolResult> {
    let input: { content: string };
    try {
      input = JSON.parse(call.input || "{}") as { content: string };
    } catch {
      return { id: call.id, ok: false, error: "invalid input", parts: [] };
    }
    let content = input.content?.trim();
    if (!content) {
      return { id: call.id, ok: false, error: "content is empty", parts: [] };
    }
    if (!content.endsWith("\n")) content += "\n";
    await mkdir(path.dirname(this.specPath), { recursive: true, mode: 0o755 });
    await writeFile(this.specPath, content, { mode: 0o644 });
    return { id: call.id, ok: true, parts: [{ type: "text", text: "spec written" }] };
  }
}

export class SpecValidateTool implements Tool {
  constructor(private specPath: string) {}

  definition(): ToolDefinition {
    return {
      name: "validate_spec",
      description: "Validate spec.md structure (Goal, Constraints, Acceptance tests).",
      kind: "read",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string" },
        },
      },
    };
  }

  async invoke(call: ToolCall): Promise<ToolResult> {
    let input: { content?: string };
    try {
      input = JSON.parse(call.input || "{}") as { content?: string };
    } catch {
      input = {};
    }
    let content = input.content?.trim() ?? "";
    if (!content) {
      content = await readFile(this.specPath, "utf8");
    }
    const { ok, problems } = validateSpecContent(content);
    const payload = { ok, problems };
    let text = `ok=${ok}\n`;
    if (problems.length) text += problems.join("\n");
    const parts: MessagePart[] = [
      { type: "text", text },
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ];
    return { id: call.id, ok, error: joinProblems(problems), parts };
  }
}

export function validateSpecContent(content: string): { ok: boolean; problems: string[] } {
  const lines = content.split("\n");
  let hasGoal = false;
  let hasConstraints = false;
  let hasAcceptance = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) continue;
    const title = trimmed.replace(/^#+/, "").trim();
    if (!title) continue;
    const lower = title.toLowerCase();
    if (lower.startsWith("goal")) hasGoal = true;
    if (lower.includes("constraint")) hasConstraints = true;
    if (lower.includes("acceptance")) hasAcceptance = true;
  }

  const problems: string[] = [];
  if (!hasGoal) problems.push("missing heading: # Goal");
  if (!hasConstraints) problems.push("missing heading: # Constraints / nuances");
  if (!hasAcceptance) problems.push("missing heading: # Acceptance tests");
  return { ok: problems.length === 0, problems };
}

function joinProblems(problems: string[]): string {
  return problems.length ? problems.join("; ") : "";
}
