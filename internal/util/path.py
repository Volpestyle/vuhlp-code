from __future__ import annotations

from pathlib import Path


def expand_home(value: str) -> str:
    if not value:
        return value
    if value == "~":
        return str(Path.home())
    if value.startswith("~/"):
        return str(Path.home() / value[2:])
    return value
