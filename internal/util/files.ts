import path from "node:path";
import { stat, readdir } from "node:fs/promises";

export interface WalkOptions {
  maxFiles: number;
  maxDepth: number;
  skipDirNames: Record<string, boolean>;
}

export function defaultWalkOptions(): WalkOptions {
  return {
    maxFiles: 5000,
    maxDepth: 30,
    skipDirNames: {
      ".git": true,
      "node_modules": true,
      "vendor": true,
      "dist": true,
      "build": true,
      "bin": true,
      ".agent-harness": true,
      ".agent-harness-cache": true,
    },
  };
}

async function walkDir(
  root: string,
  rel: string,
  opts: WalkOptions,
  out: string[],
): Promise<void> {
  const full = path.join(root, rel);
  const entries = await readdir(full, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= opts.maxFiles) return;
    const nextRel = path.join(rel, entry.name);
    const depth = nextRel === "" ? 0 : nextRel.split(path.sep).length;
    if (depth > opts.maxDepth) {
      if (entry.isDirectory()) continue;
    }
    if (entry.isDirectory()) {
      if (opts.skipDirNames[entry.name]) continue;
      await walkDir(root, nextRel, opts, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(path.posix.join(...nextRel.split(path.sep)));
  }
}

export async function walkFiles(root: string, opts: WalkOptions): Promise<string[]> {
  if (!opts.maxFiles || opts.maxFiles <= 0) {
    throw new Error("maxFiles must be > 0");
  }
  if (!opts.maxDepth || opts.maxDepth <= 0) {
    opts.maxDepth = 30;
  }
  await stat(root);
  const out: string[] = [];
  await walkDir(path.resolve(root), "", opts, out);
  return out;
}
