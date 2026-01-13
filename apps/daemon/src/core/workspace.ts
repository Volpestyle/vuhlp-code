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

  // ═══════════════════════════════════════════════════════════════════════════
  // GIT WORKTREE ISOLATION (Section 6.3)
  // These methods provide write isolation for concurrent tasks
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Prepare a git worktree for write-intensive operations.
   * This provides isolation so multiple tasks can write concurrently
   * without interfering with each other.
   */
  async prepareWorktreeForWrite(params: {
    repoPath: string;
    runId: string;
    nodeId: string;
  }): Promise<{ ok: boolean; worktreePath: string; branchName: string; error?: string }> {
    const repoPath = path.resolve(params.repoPath);

    // Must be a git repo
    if (!this.isGitRepo(repoPath)) {
      return { ok: false, worktreePath: repoPath, branchName: "", error: "Not a git repository" };
    }

    // Determine worktree location
    const rootDirAbs = path.isAbsolute(this.rootDir)
      ? this.rootDir
      : path.join(repoPath, this.rootDir);

    const worktreePath = path.join(rootDirAbs, "worktrees", params.runId, params.nodeId);
    const branchName = `vuhlp/${params.runId}/${params.nodeId}`.slice(0, 200);

    // Ensure directory structure exists
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    // Check if worktree already exists
    const worktreeListResult = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
      encoding: "utf-8",
    });

    if (worktreeListResult.status === 0 && worktreeListResult.stdout.includes(worktreePath)) {
      // Worktree already exists, just return it
      return { ok: true, worktreePath, branchName };
    }

    // Get current HEAD for the worktree
    const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      encoding: "utf-8",
    });

    if (headResult.status !== 0) {
      return { ok: false, worktreePath: repoPath, branchName: "", error: "Failed to get HEAD" };
    }

    const headSha = headResult.stdout.trim();

    // Create the worktree with a new branch
    const createResult = spawnSync(
      "git",
      ["worktree", "add", "-b", branchName, worktreePath, headSha],
      {
        cwd: repoPath,
        encoding: "utf-8",
      }
    );

    if (createResult.status !== 0) {
      // Try without -b flag if branch already exists
      const createResult2 = spawnSync(
        "git",
        ["worktree", "add", worktreePath, branchName],
        {
          cwd: repoPath,
          encoding: "utf-8",
        }
      );

      if (createResult2.status !== 0) {
        return {
          ok: false,
          worktreePath: repoPath,
          branchName: "",
          error: createResult.stderr || createResult2.stderr || "Failed to create worktree",
        };
      }
    }

    return { ok: true, worktreePath, branchName };
  }

  /**
   * Merge changes from a worktree back to the main repository.
   * This commits changes in the worktree and attempts to merge them.
   */
  async mergeWorktree(params: {
    worktreePath: string;
    repoPath: string;
    commitMessage?: string;
  }): Promise<{ ok: boolean; conflicts?: string[]; error?: string }> {
    const { worktreePath, repoPath, commitMessage } = params;

    // First, commit any changes in the worktree
    const statusResult = spawnSync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
      encoding: "utf-8",
    });

    if (statusResult.status !== 0) {
      return { ok: false, error: "Failed to check worktree status" };
    }

    const hasChanges = statusResult.stdout.trim().length > 0;

    if (hasChanges) {
      // Stage all changes
      const addResult = spawnSync("git", ["add", "-A"], {
        cwd: worktreePath,
        encoding: "utf-8",
      });

      if (addResult.status !== 0) {
        return { ok: false, error: "Failed to stage changes" };
      }

      // Commit
      const message = commitMessage || `vuhlp: automated changes from worktree`;
      const commitResult = spawnSync("git", ["commit", "-m", message], {
        cwd: worktreePath,
        encoding: "utf-8",
      });

      if (commitResult.status !== 0 && !commitResult.stderr?.includes("nothing to commit")) {
        return { ok: false, error: commitResult.stderr || "Failed to commit changes" };
      }
    }

    // Get the branch name of the worktree
    const branchResult = spawnSync("git", ["branch", "--show-current"], {
      cwd: worktreePath,
      encoding: "utf-8",
    });

    if (branchResult.status !== 0) {
      return { ok: false, error: "Failed to get worktree branch name" };
    }

    const branchName = branchResult.stdout.trim();

    if (!branchName) {
      return { ok: false, error: "Worktree is in detached HEAD state" };
    }

    // Get the current branch in the main repo
    const mainBranchResult = spawnSync("git", ["branch", "--show-current"], {
      cwd: repoPath,
      encoding: "utf-8",
    });

    const mainBranch = mainBranchResult.stdout?.trim() || "main";

    // Try to merge the worktree branch into the main repo
    const mergeResult = spawnSync(
      "git",
      ["merge", branchName, "--no-edit", "-m", `Merge ${branchName}`],
      {
        cwd: repoPath,
        encoding: "utf-8",
      }
    );

    if (mergeResult.status !== 0) {
      // Check for conflicts
      const conflictResult = spawnSync("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: repoPath,
        encoding: "utf-8",
      });

      if (conflictResult.stdout?.trim()) {
        const conflicts = conflictResult.stdout.trim().split("\n");
        // Abort the merge
        spawnSync("git", ["merge", "--abort"], { cwd: repoPath, encoding: "utf-8" });
        return { ok: false, conflicts, error: "Merge conflicts detected" };
      }

      return { ok: false, error: mergeResult.stderr || "Merge failed" };
    }

    return { ok: true };
  }

  /**
   * Clean up a worktree after it's no longer needed.
   * This removes the worktree and optionally deletes the branch.
   */
  async cleanupWorktree(
    worktreePath: string,
    repoPath: string,
    options?: { deleteBranch?: boolean }
  ): Promise<{ ok: boolean; error?: string }> {
    const { deleteBranch = true } = options ?? {};

    // Get the branch name before removing
    let branchName: string | undefined;
    if (deleteBranch) {
      const branchResult = spawnSync("git", ["branch", "--show-current"], {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      branchName = branchResult.stdout?.trim();
    }

    // Remove the worktree
    const removeResult = spawnSync("git", ["worktree", "remove", worktreePath, "--force"], {
      cwd: repoPath,
      encoding: "utf-8",
    });

    if (removeResult.status !== 0) {
      // Try pruning stale worktrees first
      spawnSync("git", ["worktree", "prune"], { cwd: repoPath, encoding: "utf-8" });

      // Try again
      const removeResult2 = spawnSync("git", ["worktree", "remove", worktreePath, "--force"], {
        cwd: repoPath,
        encoding: "utf-8",
      });

      if (removeResult2.status !== 0) {
        // Last resort: manually delete the directory
        try {
          fs.rmSync(worktreePath, { recursive: true, force: true });
          spawnSync("git", ["worktree", "prune"], { cwd: repoPath, encoding: "utf-8" });
        } catch (e: unknown) {
          const err = e as Error;
          return { ok: false, error: `Failed to remove worktree: ${err.message}` };
        }
      }
    }

    // Delete the branch if requested
    if (deleteBranch && branchName && branchName.startsWith("vuhlp/")) {
      spawnSync("git", ["branch", "-D", branchName], {
        cwd: repoPath,
        encoding: "utf-8",
      });
    }

    return { ok: true };
  }

  /**
   * Get information about all active worktrees for a run.
   */
  getActiveWorktrees(repoPath: string, runId?: string): Array<{
    path: string;
    branch: string;
    head: string;
  }> {
    const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
      encoding: "utf-8",
    });

    if (result.status !== 0) {
      return [];
    }

    const worktrees: Array<{ path: string; branch: string; head: string }> = [];
    const blocks = result.stdout.split("\n\n");

    for (const block of blocks) {
      const lines = block.split("\n");
      const pathLine = lines.find((l) => l.startsWith("worktree "));
      const headLine = lines.find((l) => l.startsWith("HEAD "));
      const branchLine = lines.find((l) => l.startsWith("branch "));

      if (pathLine && headLine && branchLine) {
        const worktreePath = pathLine.replace("worktree ", "");
        const head = headLine.replace("HEAD ", "");
        const branch = branchLine.replace("branch refs/heads/", "");

        // Filter by runId if specified
        if (runId && !worktreePath.includes(runId)) {
          continue;
        }

        // Only include vuhlp-created worktrees
        if (branch.startsWith("vuhlp/")) {
          worktrees.push({ path: worktreePath, branch, head });
        }
      }
    }

    return worktrees;
  }

  /**
   * Clean up all worktrees for a completed run.
   */
  async cleanupRunWorktrees(repoPath: string, runId: string): Promise<{ cleaned: number; errors: string[] }> {
    const worktrees = this.getActiveWorktrees(repoPath, runId);
    const errors: string[] = [];
    let cleaned = 0;

    for (const worktree of worktrees) {
      const result = await this.cleanupWorktree(worktree.path, repoPath, { deleteBranch: true });
      if (result.ok) {
        cleaned++;
      } else if (result.error) {
        errors.push(`${worktree.path}: ${result.error}`);
      }
    }

    return { cleaned, errors };
  }
}
