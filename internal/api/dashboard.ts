import path from "node:path";
import { stat } from "node:fs/promises";

const dashboardFallbackHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Agent Harness</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; background: #f6f7f9; color: #1c1f24; }
    main { max-width: 720px; margin: 80px auto; background: #fff; border: 1px solid #d6dbe2; border-radius: 10px; padding: 24px; }
    h1 { margin: 0 0 12px 0; font-size: 18px; }
    code { background: #f0f2f5; padding: 2px 6px; border-radius: 6px; }
    pre { background: #0f1115; color: #d1d7e0; padding: 12px; border-radius: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>UI build not found</h1>
    <p>The dashboard UI is served from <code>ui/build</code>.</p>
    <p>Build it with:</p>
    <pre>cd ui
npm install
npm run build</pre>
  </main>
</body>
</html>`;

export async function handleDashboard(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/v1/")) {
    return new Response("not found", { status: 404 });
  }
  const uiRoot = await findUIRoot();
  if (!uiRoot) {
    return new Response(dashboardFallbackHTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  let rel = url.pathname;
  if (rel.startsWith("/ui")) rel = rel.slice(3) || "/";
  if (rel === "/" || rel === "") rel = "/index.html";
  const safe = safeJoin(uiRoot, rel);
  if (!safe) {
    return new Response("not found", { status: 404 });
  }
  const file = Bun.file(safe);
  if (!(await file.exists())) {
    const indexPath = safeJoin(uiRoot, "/index.html");
    if (!indexPath) return new Response("not found", { status: 404 });
    return new Response(Bun.file(indexPath));
  }
  return new Response(file);
}

async function findUIRoot(): Promise<string | null> {
  const candidates = [path.join("ui", "build"), path.join("ui", "dist")];
  const exe = process.execPath;
  if (exe) {
    const exeDir = path.dirname(exe);
    candidates.push(path.join(exeDir, "..", "ui", "build"));
    candidates.push(path.join(exeDir, "..", "ui", "dist"));
  }
  for (const dir of candidates) {
    try {
      const info = await stat(dir);
      if (info.isDirectory()) return dir;
    } catch {
      // continue
    }
  }
  return null;
}

function safeJoin(root: string, rel: string): string | null {
  const clean = path.normalize("/" + rel.replace(/^\/+/, ""));
  const full = path.join(root, clean.replace(/^\//, ""));
  const rootClean = path.resolve(root);
  if (full !== rootClean && !full.startsWith(rootClean + path.sep)) {
    return null;
  }
  return full;
}
