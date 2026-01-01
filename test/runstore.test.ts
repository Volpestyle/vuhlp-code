import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../internal/runstore";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "harness-"));
}

describe("Store", () => {
  test("CreateRun AppendEvent Export", async () => {
    const tmp = await tempDir();
    const store = new Store(tmp);
    await store.init();

    const ws = path.join(tmp, "ws");
    await mkdir(ws, { recursive: true, mode: 0o755 });
    const spec = path.join(tmp, "spec.md");
    await writeFile(spec, "# spec", { mode: 0o644 });

    const run = await store.createRun(ws, spec);
    expect(run.id).not.toBe("");

    await store.appendEvent(run.id, { ts: new Date().toISOString(), run_id: run.id, type: "log", message: "hello" });

    const events = await store.readEvents(run.id, 10);
    expect(events.length).toBeGreaterThan(0);

    const zip = await store.exportRun(run.id);
    expect(zip.length).toBeGreaterThan(0);
  });

  test("CreateSession AppendEvent Export", async () => {
    const tmp = await tempDir();
    const store = new Store(tmp);
    await store.init();

    const ws = path.join(tmp, "ws");
    await mkdir(ws, { recursive: true, mode: 0o755 });

    const session = await store.createSession(ws, "system prompt", "", "");
    expect(session.id).not.toBe("");

    await store.appendSessionEvent(session.id, {
      ts: new Date().toISOString(),
      session_id: session.id,
      type: "message_added",
    });

    const events = await store.readSessionEvents(session.id, 10);
    expect(events.length).toBeGreaterThan(0);

    const attachment = await store.saveSessionAttachment(session.id, "note.txt", "text/plain", new TextEncoder().encode("hi"));
    expect(attachment.ref).not.toBe("");

    const zip = await store.exportSession(session.id);
    expect(zip.length).toBeGreaterThan(0);
  });
});
