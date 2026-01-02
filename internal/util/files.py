from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List


@dataclass
class WalkOptions:
    max_files: int = 5000
    max_depth: int = 30
    skip_dir_names: Dict[str, bool] = field(default_factory=dict)


def default_walk_options() -> WalkOptions:
    return WalkOptions(
        max_files=5000,
        max_depth=30,
        skip_dir_names={
            ".git": True,
            "node_modules": True,
            "vendor": True,
            "dist": True,
            "build": True,
            "bin": True,
            ".agent-harness": True,
            ".agent-harness-cache": True,
        },
    )


def walk_files(root: str, opts: WalkOptions) -> List[str]:
    if not opts.max_files or opts.max_files <= 0:
        raise ValueError("max_files must be > 0")
    if not opts.max_depth or opts.max_depth <= 0:
        opts.max_depth = 30

    base = Path(root).resolve()
    if not base.exists():
        raise FileNotFoundError(root)

    out: List[str] = []

    def walk_dir(current: Path, rel: Path) -> None:
        if len(out) >= opts.max_files:
            return
        try:
            entries = list(current.iterdir())
        except OSError:
            return
        for entry in entries:
            if len(out) >= opts.max_files:
                return
            next_rel = rel / entry.name
            depth = len(next_rel.parts)
            if depth > opts.max_depth and entry.is_dir():
                continue
            if entry.is_dir():
                if opts.skip_dir_names.get(entry.name):
                    continue
                walk_dir(entry, next_rel)
                continue
            if not entry.is_file():
                continue
            out.append(next_rel.as_posix())

    walk_dir(base, Path(""))
    return out
