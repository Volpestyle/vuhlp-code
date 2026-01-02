from __future__ import annotations

import os
from pathlib import Path


def load_env_file(path: str) -> None:
    if not path:
        return
    file_path = Path(path)
    if not file_path.exists():
        return
    try:
        with file_path.open("r", encoding="utf-8") as handle:
            for raw in handle:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[len("export ") :].strip()
                if "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                if not key or key in os.environ:
                    continue
                value = value.strip()
                if len(value) >= 2 and (
                    (value[0] == '"' and value[-1] == '"')
                    or (value[0] == "'" and value[-1] == "'")
                ):
                    value = value[1:-1]
                os.environ[key] = value
    except FileNotFoundError:
        return
