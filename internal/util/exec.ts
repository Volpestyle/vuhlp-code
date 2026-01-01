import { spawn } from "node:child_process";

export interface CmdResult {
  cmd: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration: string;
}

export interface ExecOptions {
  dir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function runCommand(cmd: string, opts: ExecOptions = {}): Promise<CmdResult> {
  if (!cmd) throw new Error("cmd is empty");
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 10 * 60_000;
  const start = Date.now();

  return await new Promise<CmdResult>((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", cmd], {
      cwd: opts.dir,
      env: {
        ...process.env,
        ...(opts.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
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
    }, timeoutMs);

    const abortHandler = () => {
      child.kill("SIGKILL");
    };
    opts.signal?.addEventListener("abort", abortHandler);

    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortHandler);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortHandler);
      const exitCode = typeof code === "number" ? code : 1;
      const result: CmdResult = {
        cmd,
        exit_code: exitCode,
        stdout,
        stderr,
        duration: `${Date.now() - start}ms`,
      };
      if (exitCode === 0) {
        resolve(result);
      } else {
        const err = new Error(`command failed (exit ${exitCode})`);
        Object.assign(err, { result });
        reject(err);
      }
    });
  });
}
