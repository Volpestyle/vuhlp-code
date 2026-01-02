from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .cancel import CancelToken


class NotGitRepoError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("workspace is not a git repository (.git not found)")


@dataclass
class PatchApplyResult:
    applied: bool
    stdout: Optional[str] = None
    stderr: Optional[str] = None


def apply_unified_diff(workspace: str, diff: str, signal: CancelToken | None = None) -> PatchApplyResult:
    if not diff or not diff.strip():
        raise ValueError("diff is empty")
    git_dir = Path(workspace).resolve() / ".git"
    if not git_dir.exists():
        raise NotGitRepoError()

    process = subprocess.Popen(
        ["git", "apply", "--whitespace=nowarn", "-"],
        cwd=str(Path(workspace).resolve()),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    def kill() -> None:
        if process.poll() is None:
            process.kill()

    if signal:
        import threading

        def watch_cancel() -> None:
            signal.wait()
            kill()

        threading.Thread(target=watch_cancel, daemon=True).start()

    try:
        stdout, stderr = process.communicate(input=diff, timeout=60)
    except subprocess.TimeoutExpired:
        kill()
        stdout, stderr = process.communicate()
        err = RuntimeError("git apply failed (timeout)")
        setattr(err, "result", PatchApplyResult(applied=False, stdout=stdout, stderr=stderr))
        raise err

    if process.returncode == 0:
        return PatchApplyResult(applied=True, stdout=stdout, stderr=stderr)

    err = RuntimeError(f"git apply failed (exit {process.returncode or 1})")
    setattr(err, "result", PatchApplyResult(applied=False, stdout=stdout, stderr=stderr))
    raise err
