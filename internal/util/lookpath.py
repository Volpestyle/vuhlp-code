from __future__ import annotations

import shutil


def look_path(cmd: str) -> str:
    if not cmd:
        raise ValueError("command is empty")
    resolved = shutil.which(cmd)
    if not resolved:
        raise FileNotFoundError(f"command not found: {cmd}")
    return resolved
