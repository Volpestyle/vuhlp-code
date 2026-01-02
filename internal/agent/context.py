from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from internal.util.exec import ExecOptions, run_command
from internal.util.files import default_walk_options, walk_files
from internal.util.cancel import CancelToken
from .symbols import build_repo_map


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
    bundle.repo_map = build_repo_map(workspace, files, 400, signal)

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


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
