import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

export class NotGitRepoError extends Error {
  constructor() {
    super("workspace is not a git repository (.git not found)");
  }
}

export interface PatchApplyResult {
  applied: boolean;
  stdout?: string;
  stderr?: string;
}

export async function applyUnifiedDiff(
  workspace: string,
  diff: string,
  signal?: AbortSignal,
): Promise<PatchApplyResult> {
  if (!diff.trim()) {
    throw new Error("diff is empty");
  }
  const gitDir = path.join(path.resolve(workspace), ".git");
  try {
    await stat(gitDir);
  } catch {
    throw new NotGitRepoError();
  }

  return await new Promise<PatchApplyResult>((resolve, reject) => {
    const child = spawn("git", ["apply", "--whitespace=nowarn", "-"], {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 60_000);

    const abortHandler = () => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abortHandler);

    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      if (code === 0) {
        resolve({ applied: true, stdout, stderr });
        return;
      }
      const err = new Error(`git apply failed (exit ${code ?? 1})`);
      Object.assign(err, { result: { applied: false, stdout, stderr } });
      reject(err);
    });

    child.stdin.write(diff);
    child.stdin.end();
  });
}
