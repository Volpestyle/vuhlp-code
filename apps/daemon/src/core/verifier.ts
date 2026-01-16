import { spawn } from "node:child_process";
import { log } from "./logger.js";

export interface VerificationCommandResult {
  command: string;
  ok: boolean;
  code: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  command: string,
  opts: { cwd: string; env?: Record<string, string>; signal: AbortSignal }
): Promise<VerificationCommandResult> {
  const start = Date.now();
  log.debug("Running verification command", { command, cwd: opts.cwd });

  return await new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const kill = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };
    const onAbort = () => kill();
    opts.signal.addEventListener("abort", onAbort);

    child.stdout.on("data", (d) => (stdout += d.toString("utf-8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf-8")));

    child.on("exit", (code) => {
      opts.signal.removeEventListener("abort", onAbort);
      const durationMs = Date.now() - start;
      log.debug("Verification command completed", {
        command,
        ok: code === 0,
        code,
        durationMs
      });
      resolve({
        command,
        ok: code === 0,
        code,
        durationMs,
        stdout,
        stderr,
      });
    });
  });
}

export async function verifyAll(
  commands: string[],
  opts: { cwd: string; env?: Record<string, string>; signal: AbortSignal }
): Promise<{ ok: boolean; results: VerificationCommandResult[] }> {
  log.info("Running verification commands", { count: commands.length, cwd: opts.cwd });
  const results: VerificationCommandResult[] = [];
  for (const cmd of commands) {
    const r = await runCommand(cmd, opts);
    results.push(r);
    if (!r.ok) {
      log.warn("Verification failed", { command: cmd, code: r.code });
      return { ok: false, results };
    }
  }
  log.info("Verification completed successfully", { count: results.length });
  return { ok: true, results };
}
