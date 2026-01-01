import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../internal/runstore";
import { Server } from "../internal/api/server";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "harness-"));
}

describe("Server", () => {
  test("CreateRun", async () => {
    const tmp = await tempDir();
    const store = new Store(tmp);
    await store.init();

    const ws = path.join(tmp, "ws");
    const spec = path.join(tmp, "spec.md");
    await mkdir(ws, { recursive: true, mode: 0o755 });
    await writeFile(spec, "# spec", { mode: 0o644 });

    const server = new Server(store, "", { startRun: async () => {} });
    const handler = server.handler();
    const req = new Request("http://localhost/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_path: ws, spec_path: spec }),
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  test("CreateSession", async () => {
    const tmp = await tempDir();
    const store = new Store(tmp);
    await store.init();

    const ws = path.join(tmp, "ws");
    await mkdir(ws, { recursive: true, mode: 0o755 });

    const server = new Server(store, "", undefined, { startTurn: async () => {} });
    const handler = server.handler();
    const req = new Request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_path: ws }),
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  test("CreateSession SpecMode DefaultPath", async () => {
    const tmp = await tempDir();
    const store = new Store(tmp);
    await store.init();

    const ws = path.join(tmp, "ws");
    await mkdir(ws, { recursive: true, mode: 0o755 });

    const server = new Server(store, "", undefined, { startTurn: async () => {} });
    const handler = server.handler();
    const req = new Request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_path: ws, mode: "spec" }),
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spec_path).toBeTruthy();
    await stat(body.spec_path);
  });

  test("GenerateSpec", async () => {
    const tmp = await tempDir();
    const store = new Store(tmp);
    await store.init();

    const ws = path.join(tmp, "ws");
    await mkdir(ws, { recursive: true, mode: 0o755 });

    const server = new Server(store, "", undefined, undefined, {
      generateSpec: async () => "# spec\n",
    });
    const handler = server.handler();
    const req = new Request("http://localhost/v1/specs/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_path: ws, spec_name: "my-spec", prompt: "do thing" }),
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    await stat(path.join(ws, "specs", "my-spec", "spec.md"));
  });
});
