from __future__ import annotations

import os
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Dict, Optional

from .cancel import CancelToken


@dataclass
class CmdResult:
    cmd: str
    exit_code: int
    stdout: str
    stderr: str
    duration: str


@dataclass
class ExecOptions:
    dir: Optional[str] = None
    env: Optional[Dict[str, str]] = None
    timeout_ms: Optional[int] = None
    signal: Optional[CancelToken] = None


def run_command(cmd: str, opts: ExecOptions | None = None) -> CmdResult:
    if not cmd:
        raise ValueError("cmd is empty")
    if opts is None:
        opts = ExecOptions()
    timeout_ms = opts.timeout_ms if opts.timeout_ms and opts.timeout_ms > 0 else 10 * 60_000
    start = time.time()

    env = dict(os.environ)
    if opts.env:
        env.update(opts.env)
    process = subprocess.Popen(
        ["/bin/bash", "-lc", cmd],
        cwd=opts.dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    kill_lock = threading.Lock()

    def kill() -> None:
        with kill_lock:
            if process.poll() is None:
                process.kill()

    cancel_thread = None
    if opts.signal:
        def watch_cancel() -> None:
            opts.signal.wait()
            kill()
        cancel_thread = threading.Thread(target=watch_cancel, daemon=True)
        cancel_thread.start()

    try:
        stdout, stderr = process.communicate(timeout=timeout_ms / 1000)
    except subprocess.TimeoutExpired:
        kill()
        stdout, stderr = process.communicate()
        raise RuntimeError("command failed (timeout)")
    finally:
        if cancel_thread:
            cancel_thread.join(timeout=0.1)

    exit_code = process.returncode if process.returncode is not None else 1
    result = CmdResult(
        cmd=cmd,
        exit_code=exit_code,
        stdout=stdout or "",
        stderr=stderr or "",
        duration=f"{int((time.time() - start) * 1000)}ms",
    )
    if exit_code == 0:
        return result

    err = RuntimeError(f"command failed (exit {exit_code})")
    setattr(err, "result", result)
    raise err
