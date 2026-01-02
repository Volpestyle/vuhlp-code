from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

from fastapi import Request
from fastapi.responses import FileResponse, HTMLResponse, Response


_DASHBOARD_FALLBACK_HTML = """<!doctype html>
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
</html>"""


def handle_dashboard(request: Request) -> Response:
    path = request.url.path
    if path.startswith("/v1/"):
        return Response("not found", status_code=404)
    ui_root = _find_ui_root()
    if not ui_root:
        return HTMLResponse(_DASHBOARD_FALLBACK_HTML, status_code=200)
    rel = path
    if rel.startswith("/ui"):
        rel = rel[3:] or "/"
    if rel in ("", "/"):
        rel = "/index.html"
    safe = _safe_join(ui_root, rel)
    if not safe:
        return Response("not found", status_code=404)
    if not safe.exists():
        index_path = _safe_join(ui_root, "/index.html")
        if not index_path:
            return Response("not found", status_code=404)
        return FileResponse(index_path)
    return FileResponse(safe)


def _find_ui_root() -> Optional[Path]:
    candidates = [Path("ui") / "build", Path("ui") / "dist"]
    exe = Path(sys.executable) if sys.executable else None
    if exe:
        exe_dir = exe.parent
        candidates.append(exe_dir / ".." / "ui" / "build")
        candidates.append(exe_dir / ".." / "ui" / "dist")
    for path in candidates:
        try:
            resolved = path.resolve()
            if resolved.is_dir():
                return resolved
        except Exception:
            continue
    return None


def _safe_join(root: Path, rel: str) -> Optional[Path]:
    clean = Path("/" + rel.lstrip("/")).as_posix()
    full = (root / clean.lstrip("/")).resolve()
    root_clean = root.resolve()
    if full != root_clean and root_clean not in full.parents:
        return None
    return full
