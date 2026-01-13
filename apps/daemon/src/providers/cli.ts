import { spawn } from "node:child_process";
import { ProviderOutputEvent, ProviderTask, ConsoleStreamType } from "./types.js";

export interface CliSpawnOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
  /**
   * If args contain `{prompt}`, it will be substituted.
   * If not, prompt will be written to stdin.
   */
  prompt: string;
  /** Max bytes to keep in memory for stdout/stderr (logs are also streamed). */
  maxBufferBytes?: number;
  /** Emit raw console chunks (for real-time terminal display). Default true. */
  emitConsoleChunks?: boolean;
}

export interface CliRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  parsedJsonObjects: unknown[];
  parsedJsonText?: unknown;
}

export async function* runCliStreaming(
  opts: CliSpawnOptions,
  abortSignal: AbortSignal
): AsyncIterable<ProviderOutputEvent> {
  const maxBufferBytes = opts.maxBufferBytes ?? 5_000_000; // 5MB
  const emitConsoleChunks = opts.emitConsoleChunks ?? true;
  const args = opts.args.map((a) => (a.includes("{prompt}") ? a.replaceAll("{prompt}", opts.prompt) : a));
  const usesPromptArg = opts.args.some((a) => a.includes("{prompt}"));

  yield { type: "progress", message: `[cli] spawn: ${opts.command} ${args.join(" ")}` };

  const child = spawn(opts.command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const parsedJsonObjects: unknown[] = [];
  let stdoutBuf = "";
  let stderrBuf = "";

  const kill = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  };

  const onAbort = () => kill();
  abortSignal.addEventListener("abort", onAbort);

  if (!usesPromptArg) {
    try {
      child.stdin.write(opts.prompt);
      child.stdin.end();
    } catch {
      // ignore
    }
  }

  const parseLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const obj = JSON.parse(trimmed);
      parsedJsonObjects.push(obj);
      return obj;
    } catch {
      return null;
    }
  };

  const lineIter = async function* (
    stream: NodeJS.ReadableStream,
    kind: ConsoleStreamType
  ): AsyncIterable<ProviderOutputEvent> {
    let buf = "";
    for await (const chunk of stream as any as AsyncIterable<Buffer>) {
      const s = chunk.toString("utf-8");

      // Emit raw console chunk for real-time terminal display
      if (emitConsoleChunks) {
        yield { type: "console", stream: kind, data: s, timestamp: new Date().toISOString() };
      }

      buf += s;
      while (true) {
        const idx = buf.indexOf("\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);

        if (kind === "stdout") stdoutBuf = (stdoutBuf + line + "\n").slice(-maxBufferBytes);
        if (kind === "stderr") stderrBuf = (stderrBuf + line + "\n").slice(-maxBufferBytes);

        const obj = parseLine(line);
        if (obj) {
          yield { type: "progress", message: `[cli:${kind}] json`, raw: obj };
        } else {
          yield { type: "progress", message: `[cli:${kind}] ${line}` };
        }
      }
    }
    if (buf.length) {
      if (kind === "stdout") stdoutBuf = (stdoutBuf + buf).slice(-maxBufferBytes);
      if (kind === "stderr") stderrBuf = (stderrBuf + buf).slice(-maxBufferBytes);
      const obj = parseLine(buf);
      if (obj) {
        yield { type: "progress", message: `[cli:${kind}] json`, raw: obj };
      } else {
        yield { type: "progress", message: `[cli:${kind}] ${buf}` };
      }
    }
  };

  // stream outputs interleaved
  const stdoutIter = lineIter(child.stdout, "stdout");
  const stderrIter = lineIter(child.stderr, "stderr");

  const iters = [stdoutIter[Symbol.asyncIterator](), stderrIter[Symbol.asyncIterator]()];
  let doneCount = 0;

  while (doneCount < iters.length) {
    const results = await Promise.race(
      iters.map((it, idx) =>
        it.next().then((res) => ({ idx, res }))
      )
    );

    const { idx, res } = results;
    if (res.done) {
      doneCount++;
      // replace with a never-resolving iterator to keep race stable
      iters[idx] = {
        next: async () => new Promise<any>(() => {}),
      } as any;
    } else {
      yield res.value;
    }
  }

  const exitInfo: { code: number | null; signal: NodeJS.Signals | null } = await new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  abortSignal.removeEventListener("abort", onAbort);

  // Attempt to parse full stdout as JSON (for single-JSON outputs)
  let parsedJsonText: unknown | undefined = undefined;
  const trimmed = stdoutBuf.trim();
  if (trimmed) {
    try {
      parsedJsonText = JSON.parse(trimmed);
    } catch {
      // ignore
    }
  }

  // Provide a final event (caller will store logs as artifacts).
  yield {
    type: "final",
    output: parsedJsonText ?? (parsedJsonObjects.length ? parsedJsonObjects[parsedJsonObjects.length - 1] : undefined),
    summary: exitInfo.code === 0 ? "CLI completed" : `CLI exited with code ${exitInfo.code}`,
  };

  // Attach logs as named events (caller decides how to persist).
  yield { type: "log", name: "stdout.log", content: stdoutBuf };
  if (stderrBuf.trim().length) yield { type: "log", name: "stderr.log", content: stderrBuf };
}

export function buildCliPrompt(basePrompt: string, schemaJson?: string): string {
  if (!schemaJson) return basePrompt;
  // We don't assume provider supports strict schema enforcement; we at least instruct.
  return `${basePrompt}\n\nIMPORTANT: Return valid JSON matching this schema:\n${schemaJson}\n`;
}
