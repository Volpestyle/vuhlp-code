import path from "node:path";
import { readFile } from "node:fs/promises";
import minimatch from "minimatch";
import type { ToolDefinition as AikitToolDefinition, ToolCall as AikitToolCall } from "@volpestyle/ai-kit-node";
import type { MessagePart } from "../runstore/session_models";
import { applyUnifiedDiff } from "../util/patch";
import { defaultWalkOptions, walkFiles } from "../util/files";
import { runCommand } from "../util/exec";
import { buildRepoMap } from "./context";

export type ToolKind = "read" | "write" | "exec" | "network";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  kind: ToolKind;
  requiresApproval?: boolean;
  allowWithoutApproval?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: string;
}

export interface ToolResult {
  id: string;
  ok: boolean;
  parts: MessagePart[];
  artifacts?: string[];
  error?: string;
}

export interface Tool {
  definition(): ToolDefinition;
  invoke(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
}

export interface ToolRegistry {
  definitions(): ToolDefinition[];
  invoke(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
  get(name: string): Tool | undefined;
  add(tool: Tool): void;
}

export class Registry implements ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(...tools: Tool[]) {
    for (const tool of tools) {
      this.add(tool);
    }
  }

  add(tool: Tool): void {
    if (!tool) return;
    this.tools.set(tool.definition().name, tool);
  }

  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values())
      .map((tool) => tool.definition())
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async invoke(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { id: call.id, ok: false, error: "unknown tool", parts: [] };
    }
    return tool.invoke(call, signal);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
}

export function defaultToolRegistry(workspace: string, commands: string[]): ToolRegistry {
  const verifyCommands = commands.length ? commands : ["make test"];
  return new Registry(
    new RepoTreeTool(workspace, 500),
    new RepoMapTool(workspace, 400),
    new ReadFileTool(workspace, 400),
    new SearchTool(workspace, 50),
    new GitStatusTool(workspace),
    new ApplyPatchTool(workspace),
    new ShellTool(workspace, 30 * 60_000),
    new DiagramTool(workspace),
    new VerifyTool(workspace, verifyCommands, 30 * 60_000),
  );
}

export class AikitAdapter {
  toAikitTools(defs: ToolDefinition[]): AikitToolDefinition[] {
    return defs.map((def) => ({
      name: def.name,
      description: def.description,
      parameters:
        def.parameters ?? {
          type: "object",
          properties: {},
        },
    }));
  }

  fromAikitCall(call: AikitToolCall): ToolCall {
    const raw = call.argumentsJson?.trim() || "{}";
    return { id: call.id, name: call.name, input: raw };
  }
}

function safeWorkspacePath(workspace: string, rel: string): string {
  if (!rel.trim()) throw new Error("path is empty");
  const root = path.resolve(workspace);
  const abs = path.resolve(root, rel);
  const relPath = path.relative(root, abs);
  if (relPath === ".." || relPath.startsWith(`..${path.sep}`)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return abs;
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export class RepoTreeTool implements Tool {
  constructor(private workspace: string, private maxFiles: number) {}

  definition(): ToolDefinition {
    return {
      name: "repo_tree",
      description: "List files in the workspace (relative paths).",
      kind: "read",
      parameters: {
        type: "object",
        properties: {
          max_files: { type: "integer" },
        },
      },
    };
  }

  async invoke(call: ToolCall): Promise<ToolResult> {
    let maxFiles = this.maxFiles;
    try {
      const parsed = JSON.parse(call.input || "{}") as { max_files?: number };
      if (parsed.max_files && parsed.max_files > 0) maxFiles = parsed.max_files;
    } catch {
      // ignore
    }
    const files = await walkFiles(this.workspace, defaultWalkOptions());
    const slice = maxFiles > 0 ? files.slice(0, maxFiles) : files;
    const text = slice.length ? slice.join("\n") : "workspace contains no files";
    return { id: call.id, ok: true, parts: [{ type: "text", text }] };
  }
}

export class RepoMapTool implements Tool {
  constructor(private workspace: string, private maxSymbols: number) {}

  definition(): ToolDefinition {
    return {
      name: "repo_map",
      description: "List symbols in the repo (Go/Python/JS/TS).",
      kind: "read",
      parameters: {
        type: "object",
        properties: {
          max_symbols: { type: "integer" },
        },
      },
    };
  }

  async invoke(call: ToolCall): Promise<ToolResult> {
    let maxSymbols = this.maxSymbols;
    try {
      const parsed = JSON.parse(call.input || "{}") as { max_symbols?: number };
      if (parsed.max_symbols && parsed.max_symbols > 0) maxSymbols = parsed.max_symbols;
    } catch {
      // ignore
    }
    if (maxSymbols <= 0) maxSymbols = 400;
    const files = await walkFiles(this.workspace, defaultWalkOptions());
    const out = buildRepoMap(this.workspace, files, maxSymbols);
    return { id: call.id, ok: true, parts: [{ type: "text", text: out }] };
  }
}

export class ReadFileTool implements Tool {
  constructor(private workspace: string, private maxLines: number) {}

  definition(): ToolDefinition {
    return {
      name: "read_file",
      description: "Read a file from the workspace with optional line range.",
      kind: "read",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
        },
        required: ["path"],
      },
    };
  }

  async invoke(call: ToolCall): Promise<ToolResult> {
    let input: { path: string; start_line?: number; end_line?: number };
    try {
      input = JSON.parse(call.input || "{}") as { path: string; start_line?: number; end_line?: number };
    } catch {
      return { id: call.id, ok: false, error: "invalid input", parts: [] };
    }
    const abs = safeWorkspacePath(this.workspace, input.path);
    const content = await readFile(abs, "utf8");
    const lines = content.split("\n");
    let start = input.start_line && input.start_line > 0 ? input.start_line : 1;
    let end = input.end_line && input.end_line > 0 ? input.end_line : lines.length;
    if (start < 1) start = 1;
    if (end > lines.length) end = lines.length;
    if (start > end) start = end;
    if (this.maxLines > 0 && end - start + 1 > this.maxLines) {
      end = Math.min(lines.length, start + this.maxLines - 1);
    }
    const snippet = lines.slice(start - 1, end).join("\n");
    return { id: call.id, ok: true, parts: [{ type: "text", text: snippet }] };
  }
}

export class SearchTool implements Tool {
  constructor(private workspace: string, private maxResults: number) {}

  definition(): ToolDefinition {
    return {
      name: "search",
      description: "Search for a substring in files.",
      kind: "read",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          glob: { type: "string" },
          max_results: { type: "integer" },
        },
        required: ["query"],
      },
    };
  }

  async invoke(call: ToolCall): Promise<ToolResult> {
    let input: { query: string; glob?: string; max_results?: number };
    try {
      input = JSON.parse(call.input || "{}") as { query: string; glob?: string; max_results?: number };
    } catch {
      return { id: call.id, ok: false, error: "invalid input", parts: [] };
    }
    const query = input.query?.trim();
    if (!query) {
      return { id: call.id, ok: false, error: "query required", parts: [] };
    }
    let maxResults = this.maxResults;
    if (input.max_results && input.max_results > 0) maxResults = input.max_results;
    if (maxResults <= 0) maxResults = 50;
    const files = await walkFiles(this.workspace, defaultWalkOptions());
    const matches: string[] = [];
    for (const rel of files) {
      if (matches.length >= maxResults) break;
      if (input.glob && !minimatch(path.basename(rel), input.glob)) continue;
      const abs = path.join(this.workspace, rel);
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxResults) break;
        if (lines[i].includes(query)) {
          matches.push(`${rel}:${i + 1}:${lines[i].trim()}`);
        }
      }
    }
    return { id: call.id, ok: true, parts: [{ type: "text", text: matches.join("\n") }] };
  }
}

export class GitStatusTool implements Tool {
  constructor(private workspace: string) {}

  definition(): ToolDefinition {
    return {
      name: "git_status",
      description: "Return git status --porcelain for the workspace.",
      kind: "read",
      parameters: { type: "object", properties: {} },
    };
  }

  async invoke(call: ToolCall): Promise<ToolResult> {
    try {
      const res = await runCommand("git status --porcelain", { dir: this.workspace, timeoutMs: 10_000 });
      return { id: call.id, ok: true, parts: [{ type: "text", text: res.stdout.trim() }] };
    } catch (err: unknown) {
      const result = (err as { result?: { stdout?: string; stderr?: string } }).result;
      return { id: call.id, ok: false, error: (err as Error).message, parts: [{ type: "text", text: result?.stdout ?? "" }] };
    }
  }
}

export class ApplyPatchTool implements Tool {
  constructor(private workspace: string) {}

  definition(): ToolDefinition {
    return {
      name: "apply_patch",
      description: "Apply a unified diff patch using git apply.",
      kind: "write",
      requiresApproval: true,
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string" },
        },
        required: ["patch"],
      },
    };
  }

  async invoke(call: ToolCall): Promise<ToolResult> {
    let input: { patch: string };
    try {
      input = JSON.parse(call.input || "{}") as { patch: string };
    } catch {
      return { id: call.id, ok: false, error: "invalid input", parts: [] };
    }
    try {
      const res = await applyUnifiedDiff(this.workspace, input.patch);
      return { id: call.id, ok: true, parts: [{ type: "text", text: toJson(res) }] };
    } catch (err: unknown) {
      const result = (err as { result?: unknown }).result ?? { applied: false };
      return {
        id: call.id,
        ok: false,
        error: (err as Error).message,
        parts: [{ type: "text", text: toJson(result) }],
      };
    }
  }
}

export class ShellTool implements Tool {
  constructor(private workspace: string, private timeoutMs: number) {}

  definition(): ToolDefinition {
    return {
      name: "shell",
      description: "Run a shell command in the workspace.",
      kind: "exec",
      requiresApproval: true,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_seconds: { type: "integer" },
        },
        required: ["command"],
      },
    };
  }

  async invoke(call: ToolCall): Promise<ToolResult> {
    let input: { command: string; timeout_seconds?: number };
    try {
      input = JSON.parse(call.input || "{}") as { command: string; timeout_seconds?: number };
    } catch {
      return { id: call.id, ok: false, error: "invalid input", parts: [] };
    }
    const timeout = input.timeout_seconds ? input.timeout_seconds * 1000 : this.timeoutMs;
    try {
      const res = await runCommand(input.command, { dir: this.workspace, timeoutMs: timeout });
      return { id: call.id, ok: true, parts: [{ type: "text", text: toJson(res) }] };
    } catch (err: unknown) {
      const result = (err as { result?: unknown }).result ?? {};
      return {
        id: call.id,
        ok: false,
        error: (err as Error).message,
        parts: [{ type: "text", text: toJson(result) }],
      };
    }
  }
}

export class DiagramTool implements Tool {
  constructor(private workspace: string) {}

  definition(): ToolDefinition {
    return {
      name: "diagram",
      description: "Render diagrams using make diagrams.",
      kind: "exec",
      requiresApproval: true,
      parameters: { type: "object", properties: {} },
    };
  }

  async invoke(call: ToolCall): Promise<ToolResult> {
    try {
      const res = await runCommand("make diagrams", { dir: this.workspace, timeoutMs: 30 * 60_000 });
      return { id: call.id, ok: true, parts: [{ type: "text", text: toJson(res) }] };
    } catch (err: unknown) {
      const result = (err as { result?: unknown }).result ?? {};
      return {
        id: call.id,
        ok: false,
        error: (err as Error).message,
        parts: [{ type: "text", text: toJson(result) }],
      };
    }
  }
}

export class VerifyTool implements Tool {
  constructor(private workspace: string, private commands: string[], private timeoutMs: number) {}

  definition(): ToolDefinition {
    return {
      name: "verify",
      description: "Run verification commands.",
      kind: "exec",
      parameters: { type: "object", properties: {} },
    };
  }

  async invoke(call: ToolCall): Promise<ToolResult> {
    if (!this.commands.length) this.commands = ["make test"];
    const results: Array<Record<string, unknown>> = [];
    let ok = true;
    for (const cmd of this.commands) {
      try {
        const res = await runCommand(cmd, { dir: this.workspace, timeoutMs: this.timeoutMs });
        results.push({
          cmd: res.cmd,
          exit_code: res.exit_code,
          stdout: res.stdout,
          stderr: res.stderr,
          duration: res.duration,
        });
      } catch (err: unknown) {
        ok = false;
        const result = (err as { result?: Record<string, unknown> }).result;
        results.push({
          cmd,
          exit_code: (result as { exit_code?: number })?.exit_code ?? 1,
          stdout: (result as { stdout?: string })?.stdout ?? "",
          stderr: (result as { stderr?: string })?.stderr ?? (err as Error).message,
          duration: (result as { duration?: string })?.duration ?? "",
        });
      }
    }
    const out = toJson(results);
    if (!ok) {
      return { id: call.id, ok: false, error: "verification failed", parts: [{ type: "text", text: out }] };
    }
    return { id: call.id, ok: true, parts: [{ type: "text", text: out }] };
  }
}
