import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { runCommand } from "../util/exec";
import { defaultWalkOptions, walkFiles } from "../util/files";

export interface ContextBundle {
  agents_md?: string;
  repo_tree?: string;
  repo_map?: string;
  git_status?: string;
  workspace?: string;
  generated_at: string;
}

export async function gatherContext(workspace: string, signal?: AbortSignal): Promise<ContextBundle> {
  const bundle: ContextBundle = {
    workspace,
    generated_at: new Date().toISOString(),
  };

  try {
    const agents = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
    bundle.agents_md = agents;
  } catch {
    // optional
  }

  const files = await walkFiles(workspace, defaultWalkOptions());
  const tree = files.slice(0, 500);
  bundle.repo_tree = tree.join("\n");
  bundle.repo_map = buildRepoMap(workspace, files, 400);

  try {
    await stat(path.join(workspace, ".git"));
    const res = await runCommand("git status --porcelain", {
      dir: workspace,
      timeoutMs: 10_000,
      signal,
    });
    bundle.git_status = res.stdout.trim();
  } catch {
    // ignore
  }

  return bundle;
}

interface SymbolEntry {
  file: string;
  line: number;
  name: string;
  kind: string;
}

export function buildRepoMap(workspace: string, files: string[], maxSymbols: number): string {
  const symbols: SymbolEntry[] = [];
  const rePy = /^(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
  const reJS = /^(export\s+)?(async\s+)?(function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/;
  const reJS2 = /^(export\s+)?(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*/;

  for (const rel of files) {
    if (symbols.length >= maxSymbols) break;
    const ext = path.extname(rel).toLowerCase();
    const abs = path.join(workspace, rel);
    if (![".py", ".js", ".ts", ".tsx", ".jsx"].includes(ext)) {
      continue;
    }
    let content: string;
    try {
      content = Bun.file(abs).textSync();
    } catch {
      continue;
    }
    const lines = content.split("\n").slice(0, 300);
    for (let i = 0; i < lines.length; i++) {
      if (symbols.length >= maxSymbols) break;
      const line = lines[i].trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      if (ext === ".py") {
        const match = line.match(rePy);
        if (match) {
          symbols.push({ file: rel, line: i + 1, name: match[2], kind: match[1] });
        }
      } else {
        const match = line.match(reJS);
        if (match) {
          symbols.push({ file: rel, line: i + 1, name: match[4], kind: match[3] });
          continue;
        }
        const match2 = line.match(reJS2);
        if (match2) {
          symbols.push({ file: rel, line: i + 1, name: match2[3], kind: match2[2] });
        }
      }
    }
  }

  symbols.sort((a, b) => {
    if (a.file === b.file) return a.line - b.line;
    return a.file.localeCompare(b.file);
  });

  let out = "";
  let lastFile = "";
  for (const sym of symbols) {
    if (sym.file !== lastFile) {
      if (lastFile) out += "\n";
      out += `${sym.file}:\n`;
      lastFile = sym.file;
    }
    out += `  - ${sym.kind} ${sym.name} (line ${sym.line})\n`;
  }
  return out.trim();
}
