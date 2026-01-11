import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type WorkspaceMode = "shared" | "worktree" | "copy";

export interface WorkspaceManagerOpts {
  mode: WorkspaceMode;
  rootDir: string; // relative to repoPath if not absolute
}

export class WorkspaceManager {
  private mode: WorkspaceMode;
  private rootDir: string;

  constructor(opts: WorkspaceManagerOpts) {
    this.mode = opts.mode;
    this.rootDir = opts.rootDir;
  }

  async prepareWorkspace(params: { repoPath: string; runId: string; nodeId: string }): Promise<string> {
    const repoPath = path.resolve(params.repoPath);

    if (this.mode === "shared") return repoPath;

    const rootDirAbs = path.isAbsolute(this.rootDir)
      ? this.rootDir
      : path.join(repoPath, this.rootDir);

    const wsPath = path.join(rootDirAbs, params.runId, params.nodeId);
    fs.mkdirSync(wsPath, { recursive: true });

    if (this.mode === "copy") {
      // Node 22 supports fs.cpSync.
      // Note: this can be slow on large repos.
      if (!fs.existsSync(wsPath) || fs.readdirSync(wsPath).length === 0) {
        fs.cpSync(repoPath, wsPath, {
          recursive: true,
          dereference: false,
          filter: (src) => {
            // avoid copying workspaces within workspaces
            const rel = path.relative(repoPath, src);
            if (rel.startsWith(".vuhlp/workspaces")) return false;
            return true;
          },
        });
      }
      return wsPath;
    }

    if (this.mode === "worktree") {
      // Best-effort: create a git worktree.
      // If it fails, fallback to shared.
      const gitOk = this.isGitRepo(repoPath);
      if (!gitOk) return repoPath;

      const branchName = `vuhlp/${params.runId}/${params.nodeId}`.slice(0, 200);
      const res = spawnSync("git", ["worktree", "add", "-B", branchName, wsPath, "HEAD"], {
        cwd: repoPath,
        encoding: "utf-8",
      });
      if (res.status !== 0) {
        // Some git versions require different args; fallback
        return repoPath;
      }
      return wsPath;
    }

    return repoPath;
  }

  isGitRepo(repoPath: string): boolean {
    try {
      const res = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: repoPath,
        encoding: "utf-8",
      });
      return res.status === 0 && res.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  captureGitDiff(workspacePath: string): { ok: boolean; diff: string; status: string } {
    try {
      const diff = spawnSync("git", ["diff"], { cwd: workspacePath, encoding: "utf-8" });
      const status = spawnSync("git", ["status", "--porcelain"], {
        cwd: workspacePath,
        encoding: "utf-8",
      });
      const ok = diff.status === 0 && status.status === 0;
      return { ok, diff: diff.stdout ?? "", status: status.stdout ?? "" };
    } catch {
      return { ok: false, diff: "", status: "" };
    }
  }
}
