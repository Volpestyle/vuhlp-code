from __future__ import annotations

from pathlib import Path


default_spec_content = """# Goal

<describe the goal>

# Constraints / nuances

- <constraints>

# Acceptance tests

- <acceptance tests>
"""


def default_spec_path(workspace_path: str, name: str) -> str:
    if not workspace_path.strip():
        raise ValueError("workspace path is empty")
    if not name.strip():
        raise ValueError("spec name is empty")
    return str(Path(workspace_path).resolve() / "specs" / name / "spec.md")


def ensure_spec_file(spec_path: str) -> bool:
    if not spec_path.strip():
        raise ValueError("spec path is empty")
    target = Path(spec_path)
    if target.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    content = default_spec_content
    if not content.endswith("\n"):
        content += "\n"
    target.write_text(content, encoding="utf-8")
    return True
