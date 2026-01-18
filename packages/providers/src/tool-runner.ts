import { exec as execCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { GlobalMode, NodeCapabilities, ProviderName, ToolCall } from "@vuhlp/contracts";
import type {
  CreateEdgeHandler,
  CreateEdgeRequest,
  SpawnNodeHandler,
  SpawnNodeRequest
} from "./types.js";
import type { Logger } from "./logger.js";

const exec = promisify(execCallback);

export interface ToolExecutionOptions {
  cwd: string;
  capabilities?: NodeCapabilities;
  globalMode?: GlobalMode;
  defaultProvider?: ProviderName;
  spawnNode?: SpawnNodeHandler;
  createEdge?: CreateEdgeHandler;
  logger?: Logger;
}

export interface ToolExecutionResult {
  ok: boolean;
  output: string;
  error?: string;
}

const DOCS_ROOT = "docs";

function normalizeRoot(root: string): string {
  return path.resolve(root);
}

function resolvePath(root: string, target: string): string {
  const resolved = path.resolve(root, target);
  const safeRoot = normalizeRoot(root);
  if (!resolved.startsWith(`${safeRoot}${path.sep}`) && resolved !== safeRoot) {
    throw new Error(`Path escapes repo root: ${target}`);
  }
  return resolved;
}

function isDocsPath(root: string, target: string): boolean {
  const safeRoot = normalizeRoot(root);
  const resolved = resolvePath(safeRoot, target);
  const relative = path.relative(safeRoot, resolved);
  return relative === DOCS_ROOT || relative.startsWith(`${DOCS_ROOT}${path.sep}`);
}

function canRunCommands(options: ToolExecutionOptions): string | null {
  if (!options.capabilities) {
    return null;
  }
  if (!options.capabilities.runCommands) {
    return "runCommands capability is disabled";
  }
  if (options.capabilities.delegateOnly) {
    return "delegateOnly is enabled";
  }
  return null;
}

function canWritePath(options: ToolExecutionOptions, target: string): string | null {
  if (!options.capabilities && !options.globalMode) {
    return null;
  }
  if (options.capabilities?.delegateOnly) {
    return "delegateOnly is enabled";
  }
  const root = options.cwd;
  const docsPath = isDocsPath(root, target);
  if (options.globalMode === "PLANNING" && !docsPath) {
    return "write restricted to docs/ in PLANNING mode";
  }
  if (docsPath) {
    if (options.capabilities && !options.capabilities.writeDocs) {
      return "writeDocs capability is disabled";
    }
  } else if (options.capabilities && !options.capabilities.writeCode) {
    return "writeCode capability is disabled";
  }
  return null;
}

function canSpawn(options: ToolExecutionOptions): string | null {
  if (!options.capabilities) {
    return null;
  }
  if (!options.capabilities.spawnNodes) {
    return "spawnNodes capability is disabled";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildSpawnRequest(args: Record<string, unknown>, defaultProvider?: ProviderName): SpawnNodeRequest | null {
  const label = typeof args.label === "string" ? args.label.trim() : "";
  const roleTemplate =
    typeof args.roleTemplate === "string"
      ? args.roleTemplate.trim()
      : typeof args.role === "string"
        ? args.role.trim()
        : "";
  const provider = typeof args.provider === "string" ? (args.provider as ProviderName) : defaultProvider;
  if (!label || !roleTemplate || !provider) {
    return null;
  }
  const customSystemPrompt =
    typeof args.customSystemPrompt === "string" ? args.customSystemPrompt : args.customSystemPrompt === null ? null : undefined;
  const capabilities = isRecord(args.capabilities) ? (args.capabilities as SpawnNodeRequest["capabilities"]) : undefined;
  const permissions = isRecord(args.permissions) ? (args.permissions as SpawnNodeRequest["permissions"]) : undefined;
  const session = isRecord(args.session) ? (args.session as SpawnNodeRequest["session"]) : undefined;
  const instructions = typeof args.instructions === "string" ? args.instructions : undefined;
  const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : undefined;

  return {
    label,
    roleTemplate,
    provider,
    customSystemPrompt,
    capabilities,
    permissions,
    session,
    instructions,
    input
  };
}

function buildCreateEdgeRequest(args: Record<string, unknown>): CreateEdgeRequest | null {
  const from = typeof args.from === "string" ? args.from.trim() : "";
  const to = typeof args.to === "string" ? args.to.trim() : "";
  if (!from || !to) {
    return null;
  }
  const bidirectional = typeof args.bidirectional === "boolean" ? args.bidirectional : undefined;
  const type = typeof args.type === "string" ? (args.type as CreateEdgeRequest["type"]) : undefined;
  const label = typeof args.label === "string" ? args.label : undefined;
  return { from, to, bidirectional, type, label };
}

export async function executeToolCall(
  tool: ToolCall,
  options: ToolExecutionOptions
): Promise<ToolExecutionResult> {
  const root = normalizeRoot(options.cwd ?? process.cwd());

  switch (tool.name) {
    case "command": {
      const guard = canRunCommands(options);
      if (guard) {
        return { ok: false, output: "", error: guard };
      }
      const cmd = typeof tool.args.cmd === "string" ? tool.args.cmd : null;
      const cwdInput = typeof tool.args.cwd === "string" ? tool.args.cwd : root;
      if (!cmd) {
        return { ok: false, output: "", error: "command tool requires cmd" };
      }
      try {
        const cwd = resolvePath(root, cwdInput);
        const result = await exec(cmd, {
          cwd,
          maxBuffer: 10 * 1024 * 1024
        });
        const output = [result.stdout, result.stderr].filter(Boolean).join("");
        return { ok: true, output };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stdout = (error as { stdout?: string }).stdout ?? "";
        const stderr = (error as { stderr?: string }).stderr ?? "";
        const output = [stdout, stderr].filter(Boolean).join("");
        return { ok: false, output, error: message };
      }
    }

    case "read_file": {
      const target = typeof tool.args.path === "string" ? tool.args.path : null;
      if (!target) {
        return { ok: false, output: "", error: "read_file requires path" };
      }
      try {
        const resolved = resolvePath(root, target);
        const content = await fs.readFile(resolved, "utf8");
        return { ok: true, output: content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: "", error: message };
      }
    }

    case "write_file": {
      const target = typeof tool.args.path === "string" ? tool.args.path : null;
      const content = typeof tool.args.content === "string" ? tool.args.content : null;
      if (!target || content === null) {
        return { ok: false, output: "", error: "write_file requires path and content" };
      }
      const guard = canWritePath(options, target);
      if (guard) {
        return { ok: false, output: "", error: guard };
      }
      try {
        const resolved = resolvePath(root, target);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, "utf8");
        return { ok: true, output: `wrote ${target}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: "", error: message };
      }
    }

    case "list_files": {
      const target = typeof tool.args.path === "string" ? tool.args.path : ".";
      try {
        const resolved = resolvePath(root, target);
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        const listing = entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file"
        }));
        return { ok: true, output: JSON.stringify(listing, null, 2) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: "", error: message };
      }
    }

    case "delete_file": {
      const target = typeof tool.args.path === "string" ? tool.args.path : null;
      if (!target) {
        return { ok: false, output: "", error: "delete_file requires path" };
      }
      const guard = canWritePath(options, target);
      if (guard) {
        return { ok: false, output: "", error: guard };
      }
      try {
        const resolved = resolvePath(root, target);
        await fs.rm(resolved, { force: true });
        return { ok: true, output: `deleted ${target}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: "", error: message };
      }
    }

    case "spawn_node": {
      const guard = canSpawn(options);
      if (guard) {
        return { ok: false, output: "", error: guard };
      }
      if (!options.spawnNode) {
        return { ok: false, output: "", error: "spawn_node not supported" };
      }
      const args = isRecord(tool.args) ? tool.args : {};
      const request = buildSpawnRequest(args, options.defaultProvider);
      if (!request) {
        return {
          ok: false,
          output: "",
          error: "spawn_node requires label, roleTemplate (or role), and provider"
        };
      }
      try {
        const result = await options.spawnNode(request);
        return { ok: true, output: JSON.stringify(result) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: "", error: message };
      }
    }

    case "create_edge": {
      const guard = canSpawn(options);
      if (guard) {
        return { ok: false, output: "", error: guard };
      }
      if (!options.createEdge) {
        return { ok: false, output: "", error: "create_edge not supported" };
      }
      const args = isRecord(tool.args) ? tool.args : {};
      const request = buildCreateEdgeRequest(args);
      if (!request) {
        return { ok: false, output: "", error: "create_edge requires from and to node ids" };
      }
      try {
        const result = await options.createEdge(request);
        return { ok: true, output: JSON.stringify(result) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: "", error: message };
      }
    }

    default:
      return { ok: false, output: "", error: `unsupported tool: ${tool.name}` };
  }
}
