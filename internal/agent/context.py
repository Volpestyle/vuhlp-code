from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from internal.util.exec import ExecOptions, run_command
from internal.util.files import default_walk_options, walk_files
from internal.util.cancel import CancelToken


@dataclass
class ContextBundle:
    generated_at: str
    workspace: Optional[str] = None
    agents_md: Optional[str] = None
    repo_tree: Optional[str] = None
    repo_map: Optional[str] = None
    git_status: Optional[str] = None


def gather_context(workspace: str, signal: CancelToken | None = None) -> ContextBundle:
    bundle = ContextBundle(workspace=workspace, generated_at=_now())
    root = Path(workspace)

    try:
        bundle.agents_md = (root / "AGENTS.md").read_text(encoding="utf-8")
    except Exception:
        pass

    files = walk_files(workspace, default_walk_options())
    bundle.repo_tree = "\n".join(files[:500])
    bundle.repo_map = build_repo_map(workspace, files, 400)

    try:
        if (root / ".git").exists():
            res = run_command(
                "git status --porcelain",
                ExecOptions(dir=workspace, timeout_ms=10_000, signal=signal),
            )
            bundle.git_status = res.stdout.strip()
    except Exception:
        pass

    return bundle


@dataclass
class SymbolEntry:
    file: str
    line: int
    name: str
    kind: str


def build_repo_map(workspace: str, files: List[str], max_symbols: int) -> str:
    symbols: List[SymbolEntry] = []
    re_py = re.compile(r"^(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b")
    re_js = re.compile(r"^(export\s+)?(async\s+)?(function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b")
    re_js2 = re.compile(r"^(export\s+)?(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*")

    root = Path(workspace)

    for rel in files:
        if len(symbols) >= max_symbols:
            break
        ext = Path(rel).suffix.lower()
        if ext not in {".py", ".js", ".ts", ".tsx", ".jsx"}:
            continue
        abs_path = root / rel
        try:
            content = abs_path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        lines = content.split("\n")[:300]
        for idx, line in enumerate(lines, start=1):
            if len(symbols) >= max_symbols:
                break
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or stripped.startswith("//"):
                continue
            if ext == ".py":
                match = re_py.match(stripped)
                if match:
                    symbols.append(SymbolEntry(file=rel, line=idx, name=match.group(2), kind=match.group(1)))
            else:
                match = re_js.match(stripped)
                if match:
                    symbols.append(SymbolEntry(file=rel, line=idx, name=match.group(4), kind=match.group(3)))
                    continue
                match2 = re_js2.match(stripped)
                if match2:
                    symbols.append(SymbolEntry(file=rel, line=idx, name=match2.group(3), kind=match2.group(2)))

    symbols.sort(key=lambda s: (s.file, s.line))

    out = []
    last_file = ""
    for sym in symbols:
        if sym.file != last_file:
            if last_file:
                out.append("")
            out.append(f"{sym.file}:")
            last_file = sym.file
        out.append(f"  - {sym.kind} {sym.name} (line {sym.line})")

    return "\n".join(out).strip()


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
