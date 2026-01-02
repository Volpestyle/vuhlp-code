from __future__ import annotations

import importlib.util
import sysconfig
from pathlib import Path


# Re-export stdlib cmd to avoid shadowing issues (e.g., pdb importing cmd.Cmd).
def _load_stdlib_cmd():
    stdlib_path = Path(sysconfig.get_paths()["stdlib"]) / "cmd.py"
    spec = importlib.util.spec_from_file_location("_stdlib_cmd", stdlib_path)
    if not spec or not spec.loader:
        raise ImportError("unable to load stdlib cmd module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_stdlib_cmd = _load_stdlib_cmd()
for _name in dir(_stdlib_cmd):
    if _name.startswith("__"):
        continue
    globals().setdefault(_name, getattr(_stdlib_cmd, _name))
