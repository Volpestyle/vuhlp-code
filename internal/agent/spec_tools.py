from __future__ import annotations

import json
from pathlib import Path
from typing import List

from internal.runstore.session_models import MessagePart
from .tools import Tool, ToolCall, ToolDefinition, ToolResult


class SpecReadTool(Tool):
    def __init__(self, spec_path: str) -> None:
        self._spec_path = spec_path

    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="read_spec",
            description="Read the current spec.md content.",
            kind="read",
            parameters={"type": "object", "properties": {}},
        )

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        try:
            content = Path(self._spec_path).read_text(encoding="utf-8")
            return ToolResult(id=call.id, ok=True, parts=[MessagePart(type="text", text=content)])
        except Exception as err:
            return ToolResult(
                id=call.id,
                ok=False,
                error=str(err),
                parts=[MessagePart(type="text", text="spec not found")],
            )


class SpecWriteTool(Tool):
    def __init__(self, spec_path: str) -> None:
        self._spec_path = spec_path

    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="write_spec",
            description="Overwrite spec.md with full content.",
            kind="write",
            allow_without_approval=True,
            parameters={
                "type": "object",
                "properties": {"content": {"type": "string"}},
                "required": ["content"],
            },
        )

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        try:
            payload = json.loads(call.input or "{}")
        except Exception:
            return ToolResult(id=call.id, ok=False, error="invalid input", parts=[])
        content = (payload.get("content") or "").strip()
        if not content:
            return ToolResult(id=call.id, ok=False, error="content is empty", parts=[])
        if not content.endswith("\n"):
            content += "\n"
        spec_path = Path(self._spec_path)
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text(content, encoding="utf-8")
        return ToolResult(id=call.id, ok=True, parts=[MessagePart(type="text", text="spec written")])


class SpecValidateTool(Tool):
    def __init__(self, spec_path: str) -> None:
        self._spec_path = spec_path

    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="validate_spec",
            description="Validate spec.md structure (Goal, Constraints, Acceptance tests).",
            kind="read",
            parameters={"type": "object", "properties": {"content": {"type": "string"}}},
        )

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        try:
            payload = json.loads(call.input or "{}")
        except Exception:
            payload = {}
        content = (payload.get("content") or "").strip()
        if not content:
            content = Path(self._spec_path).read_text(encoding="utf-8")
        result = validate_spec_content(content)
        payload = {"ok": result[0], "problems": result[1]}
        text = f"ok={result[0]}\n"
        if result[1]:
            text += "\n".join(result[1])
        parts: List[MessagePart] = [
            MessagePart(type="text", text=text),
            MessagePart(type="text", text=json.dumps(payload, indent=2)),
        ]
        return ToolResult(id=call.id, ok=result[0], error=_join_problems(result[1]), parts=parts)


def validate_spec_content(content: str) -> tuple[bool, List[str]]:
    lines = content.split("\n")
    has_goal = False
    has_constraints = False
    has_acceptance = False

    for line in lines:
        stripped = line.strip()
        if not stripped.startswith("#"):
            continue
        title = stripped.lstrip("#").strip()
        if not title:
            continue
        lower = title.lower()
        if lower.startswith("goal"):
            has_goal = True
        if "constraint" in lower:
            has_constraints = True
        if "acceptance" in lower:
            has_acceptance = True

    problems: List[str] = []
    if not has_goal:
        problems.append("missing heading: # Goal")
    if not has_constraints:
        problems.append("missing heading: # Constraints / nuances")
    if not has_acceptance:
        problems.append("missing heading: # Acceptance tests")
    return len(problems) == 0, problems


def _join_problems(problems: List[str]) -> str:
    return "; ".join(problems) if problems else ""
