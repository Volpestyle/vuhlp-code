#!/usr/bin/env bun
import minimist from "minimist";
import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { lookup as lookupMime } from "mime-types";
import { lookPath } from "../../internal/util/lookpath";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    usage();
    process.exit(2);
  }

  const cmd = args[0];
  switch (cmd) {
    case "init":
      await cmdInit(args.slice(1));
      break;
    case "spec":
      await cmdSpec(args.slice(1));
      break;
    case "run":
      await cmdRun(args.slice(1));
      break;
    case "attach":
      await cmdAttach(args.slice(1));
      break;
    case "approve":
      await cmdApprove(args.slice(1));
      break;
    case "session":
      await cmdSession(args.slice(1));
      break;
    case "list":
      await cmdList(args.slice(1));
      break;
    case "export":
      await cmdExport(args.slice(1));
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "-h":
    case "--help":
    case "help":
      usage();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      usage();
      process.exit(2);
  }
}

function usage(): void {
  console.log(`agentctl - CLI client for agentd

Usage:
  agentctl init [--force]
  agentctl spec new <name>
  agentctl spec prompt <name> --prompt <text> [--workspace <path>] [--url <base>] [--overwrite] [--print]
  agentctl run --workspace <path> --spec <path> [--url <base>]
  agentctl attach <run_id> [--url <base>]
  agentctl approve <run_id> --step <step_id> [--url <base>]
  agentctl session new --workspace <path> [--system <text>] [--mode <chat|spec>] [--spec <path>] [--url <base>]
  agentctl session message <session_id> --text <msg> [--auto-run] [--url <base>]
  agentctl session attach <session_id> --file <path> [--url <base>]
  agentctl session approve <session_id> --call <tool_call_id> [--deny] [--reason <text>] [--url <base>]
  agentctl list [--url <base>]
  agentctl export <run_id> --out <file.zip> [--url <base>]
  agentctl doctor

Environment:
  HARNESS_URL         Base URL for agentd (default http://127.0.0.1:8787)
  HARNESS_AUTH_TOKEN  Bearer token (optional, must match agentd)
`);
}

function baseURL(flagUrl?: string): string {
  if (flagUrl?.trim()) return flagUrl.trim().replace(/\/+$/, "");
  const env = process.env.HARNESS_URL ?? "";
  if (env.trim()) return env.trim().replace(/\/+$/, "");
  return "http://127.0.0.1:8787";
}

function authToken(): string {
  return (process.env.HARNESS_AUTH_TOKEN ?? "").trim();
}

async function doJSON(method: string, url: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const tok = authToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status >= 400) {
    const text = await res.text();
    throw new Error(`http ${res.status}: ${text.trim()}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function cmdInit(args: string[]): Promise<void> {
  const parsed = minimist(args);
  const force = Boolean(parsed.force);
  const cwd = process.cwd();

  const write = async (rel: string, content: string): Promise<void> => {
    const filePath = path.join(cwd, rel);
    if (!force) {
      try {
        await readFile(filePath);
        console.log(`[init] exists, skipping: ${rel}`);
        return;
      } catch {
        // continue
      }
    }
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
    await writeFile(filePath, content, { mode: 0o644 });
  };

  const agents = `# AGENTS.md

Project-specific instructions for coding agents.

## Build
- make test

## Safety
- Destructive commands require approval.
`;
  await write("AGENTS.md", agents);
  await write("docs/diagrams/README.md", "Diagram sources (.mmd/.dac) and exported PNGs live here.\n");
  await write("docs/diagrams/agent-harness.mmd", "flowchart LR\n  A[spec]-->B[agent]\n");
  await write("specs/README.md", "# Specs\n\nSpecs live in specs/<name>/spec.md\n");
  await write("specs/example/spec.md", "# Example spec\n\nDescribe the goal + acceptance tests.\n");

  console.log("[init] done");
}

async function cmdSpec(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error("spec requires a subcommand (new)");
    process.exit(2);
  }
  const sub = args[0];
  if (sub === "new") {
    await cmdSpecNew(args.slice(1));
  } else if (sub === "prompt") {
    await cmdSpecPrompt(args.slice(1));
  } else {
    console.error(`unknown spec subcommand: ${sub}`);
    process.exit(2);
  }
}

async function cmdSpecNew(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error("usage: agentctl spec new <name>");
    process.exit(2);
  }
  const name = args[0];
  const cwd = process.cwd();
  const dir = path.join(cwd, "specs", name);
  await mkdir(path.join(dir, "diagrams"), { recursive: true, mode: 0o755 });
  const specPath = path.join(dir, "spec.md");
  try {
    await readFile(specPath);
    console.log(`[spec] exists: ${specPath}`);
    return;
  } catch {
    // continue
  }

  const spec = `---\nname: ${name}\nstatus: draft\n---\n\n# Goal\n\nDescribe what you want built.\n\n# Constraints\n\n- Any AWS/IaC changes require approval.\n\n# Acceptance tests\n\n- make test\n`;
  await writeFile(specPath, spec, { mode: 0o644 });
  const mmd = "flowchart LR\n  A[idea]-->B[done]\n";
  await writeFile(path.join(dir, "diagrams", "diagram.mmd"), mmd, { mode: 0o644 });
  console.log(`[spec] created: ${specPath}`);
}

async function cmdSpecPrompt(args: string[]): Promise<void> {
  const parsed = minimist(args, {
    string: ["prompt", "prompt-file", "workspace", "url"],
    boolean: ["overwrite", "print"],
    alias: { "prompt-file": "promptFile" },
  });
  const name = parsed._[0];
  if (!name) {
    die("usage: agentctl spec prompt <name> --prompt <text>");
  }
  let promptText = (parsed.prompt ?? "").trim();
  if (!promptText && parsed.promptFile) {
    promptText = (await readFile(parsed.promptFile, "utf8")).trim();
  }
  if (!promptText) {
    die("prompt text is required");
  }
  const workspace = path.resolve(parsed.workspace ?? ".");
  const resp = await doJSON("POST", `${baseURL(parsed.url)}/v1/specs/generate`, {
    workspace_path: workspace,
    spec_name: name,
    prompt: promptText,
    overwrite: Boolean(parsed.overwrite),
  });
  console.log(resp.spec_path);
  if (parsed.print) {
    console.log(resp.content);
  }
}

async function cmdRun(args: string[]): Promise<void> {
  const parsed = minimist(args, { string: ["workspace", "spec", "url"] });
  if (!parsed.spec) {
    die("--spec is required");
  }
  const workspace = path.resolve(parsed.workspace ?? ".");
  const specPath = path.resolve(parsed.spec);
  const resp = await doJSON("POST", `${baseURL(parsed.url)}/v1/runs`, {
    workspace_path: workspace,
    spec_path: specPath,
  });
  console.log(resp.run_id);
}

async function cmdAttach(args: string[]): Promise<void> {
  const parsed = minimist(args, { string: ["url"] });
  const runId = parsed._[0];
  if (!runId) {
    die("usage: agentctl attach <run_id>");
  }
  const url = `${baseURL(parsed.url)}/v1/runs/${runId}/events`;
  const headers: Record<string, string> = {};
  const tok = authToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(url, { headers });
  if (res.status >= 400) {
    const text = await res.text();
    die(`http ${res.status}: ${text.trim()}`);
  }
  await readSSE(res, (payload) => {
    try {
      const ev = JSON.parse(payload);
      printEvent(ev);
    } catch {
      console.log(payload);
    }
  });
}

function printEvent(ev: Record<string, unknown>): void {
  const ts = (ev.ts as string) ?? "";
  const type = (ev.type as string) ?? "";
  const msg = (ev.message as string) ?? "-";
  console.log(`${ts}  ${type.padEnd(22)}  ${msg || "-"}`);
}

async function cmdApprove(args: string[]): Promise<void> {
  const parsed = minimist(args, { string: ["step", "url"] });
  const runId = parsed._[0];
  const stepId = parsed.step;
  if (!runId || !stepId) {
    die("usage: agentctl approve <run_id> --step <step_id>");
  }
  await doJSON("POST", `${baseURL(parsed.url)}/v1/runs/${runId}/approve`, { step_id: stepId });
  console.log("ok");
}

async function cmdSession(args: string[]): Promise<void> {
  if (args.length < 1) {
    die("session requires a subcommand (new|message|attach|approve)");
  }
  const sub = args[0];
  if (sub === "new") return cmdSessionNew(args.slice(1));
  if (sub === "message") return cmdSessionMessage(args.slice(1));
  if (sub === "attach") return cmdSessionAttach(args.slice(1));
  if (sub === "approve") return cmdSessionApprove(args.slice(1));
  die(`unknown session subcommand: ${sub}`);
}

async function cmdSessionNew(args: string[]): Promise<void> {
  const parsed = minimist(args, { string: ["workspace", "system", "mode", "spec", "url"] });
  const workspace = path.resolve(parsed.workspace ?? ".");
  const resp = await doJSON("POST", `${baseURL(parsed.url)}/v1/sessions`, {
    workspace_path: workspace,
    system_prompt: parsed.system ?? "",
    mode: parsed.mode ?? "chat",
    spec_path: parsed.spec ?? "",
  });
  console.log(resp.session_id);
}

async function cmdSessionMessage(args: string[]): Promise<void> {
  const parsed = minimist(args, {
    string: ["text", "ref", "type", "mime", "role", "url"],
    boolean: ["auto-run"],
    default: { "auto-run": true },
  });
  const sessionId = parsed._[0];
  if (!sessionId) die("usage: agentctl session message <session_id> --text <msg>");

  const parts: Array<{ type: string; text?: string; ref?: string; mime_type?: string }> = [];
  if ((parsed.text ?? "").trim()) {
    parts.push({ type: "text", text: parsed.text });
  }
  if ((parsed.ref ?? "").trim()) {
    let typ = (parsed.type ?? "").trim();
    const mimeType = (parsed.mime ?? "").trim();
    if (!typ) {
      typ = mimeType.startsWith("image/") ? "image" : "file";
    }
    parts.push({ type: typ, ref: parsed.ref, mime_type: mimeType });
  }
  if (!parts.length) die("message requires --text or --ref");

  const resp = await doJSON("POST", `${baseURL(parsed.url)}/v1/sessions/${sessionId}/messages`, {
    role: parsed.role ?? "user",
    parts,
    auto_run: parsed["auto-run"],
  });
  console.log(`${resp.message_id} ${resp.turn_id}`);
}

async function cmdSessionAttach(args: string[]): Promise<void> {
  const parsed = minimist(args, { string: ["file", "name", "mime", "url"] });
  const sessionId = parsed._[0];
  if (!sessionId || !parsed.file) {
    die("usage: agentctl session attach <session_id> --file <path>");
  }
  const content = await readFile(parsed.file);
  const enc = Buffer.from(content).toString("base64");
  const filename = parsed.name ?? path.basename(parsed.file);
  const detected = lookupMime(filename);
  const mimeType =
    (parsed.mime ?? (typeof detected === "string" ? detected : "")) ||
    "application/octet-stream";
  const resp = await doJSON("POST", `${baseURL(parsed.url)}/v1/sessions/${sessionId}/attachments`, {
    name: filename,
    mime_type: mimeType,
    content_base64: enc,
  });
  console.log(`${resp.ref} ${resp.mime_type}`);
}

async function cmdSessionApprove(args: string[]): Promise<void> {
  const parsed = minimist(args, { string: ["call", "turn", "reason", "url"], boolean: ["deny"] });
  const sessionId = parsed._[0];
  if (!sessionId || !parsed.call) {
    die("usage: agentctl session approve <session_id> --call <tool_call_id>");
  }
  const action = parsed.deny ? "deny" : "approve";
  await doJSON("POST", `${baseURL(parsed.url)}/v1/sessions/${sessionId}/approve`, {
    turn_id: parsed.turn ?? "",
    tool_call_id: parsed.call,
    action,
    reason: parsed.reason ?? "",
  });
  console.log("ok");
}

async function cmdList(args: string[]): Promise<void> {
  const parsed = minimist(args, { string: ["url"] });
  const runs = await doJSON("GET", `${baseURL(parsed.url)}/v1/runs`);
  for (const run of runs ?? []) {
    console.log(`${run.id}  ${String(run.status).padEnd(18)}  ${run.spec_path}`);
  }
}

async function cmdExport(args: string[]): Promise<void> {
  const parsed = minimist(args, { string: ["out", "url"] });
  const runId = parsed._[0];
  if (!runId || !parsed.out) {
    die("usage: agentctl export <run_id> --out <file.zip>");
  }
  const url = `${baseURL(parsed.url)}/v1/runs/${runId}/export`;
  const headers: Record<string, string> = {};
  const tok = authToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(url, { headers });
  if (res.status >= 400) {
    const text = await res.text();
    die(`http ${res.status}: ${text.trim()}`);
  }
  const buf = await res.arrayBuffer();
  await Bun.write(parsed.out, buf);
  console.log(`wrote ${parsed.out}`);
}

async function cmdDoctor(): Promise<void> {
  console.log("doctor:");
  await check("git");
  await check("rg (ripgrep)");
  await check("mmdc (mermaid-cli)");
  await check("awsdac (diagram-as-code)");
  console.log("notes:");
  console.log("- For Mermaid diagrams, you can also use `npx -y @mermaid-js/mermaid-cli`.");
  console.log("- For remote cockpit, prefer an authenticated tunnel (Tailscale/Cloudflare)." );
}

async function check(cmd: string): Promise<void> {
  const name = cmd.split(" ")[0];
  try {
    const resolved = await lookPath(name);
    console.log(`  - ${cmd.padEnd(18)} OK (${resolved})`);
  } catch {
    console.log(`  - ${cmd.padEnd(18)} MISSING`);
  }
}

async function readSSE(res: Response, onData: (payload: string) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data: ")) {
        onData(line.slice(6));
      }
    }
  }
}

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
