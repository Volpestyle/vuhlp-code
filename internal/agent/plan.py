from __future__ import annotations

import json
from dataclasses import dataclass
from typing import List, Optional, TYPE_CHECKING

from internal.util.id import new_step_id

if TYPE_CHECKING:
    from ai_kit import Kit, Message, ModelRecord
    from .context import ContextBundle


@dataclass
class PlanStep:
    id: str
    title: str
    type: str
    needs_approval: bool
    command: Optional[str] = None
    patch: Optional[str] = None


@dataclass
class Plan:
    steps: List[PlanStep]


def default_plan() -> Plan:
    return Plan(
        steps=[
            PlanStep(
                id=new_step_id(),
                title="Run tests",
                type="command",
                needs_approval=False,
                command="make test",
            ),
            PlanStep(
                id=new_step_id(),
                title="Render diagrams (best effort)",
                type="command",
                needs_approval=False,
                command="make diagrams",
            ),
        ]
    )


def generate_plan(kit: "Kit", model: "ModelRecord", spec_text: str, bundle: "ContextBundle") -> Plan:
    if not kit:
        raise ValueError("kit is nil")
    prompt = _build_planning_prompt(spec_text, bundle)
    from ai_kit import GenerateInput, Message, ContentPart

    messages: List[Message] = [
        Message(role="user", content=[ContentPart(type="text", text=prompt)])
    ]
    output = kit.generate(
        GenerateInput(
            provider=model.provider,
            model=model.providerModelId,
            messages=messages,
        )
    )
    try:
        plan = parse_plan_from_text(output.text or "")
        _normalize_plan(plan)
        return plan
    except Exception:
        return default_plan()


def parse_plan_from_text(text: str) -> Plan:
    value = text.strip()
    if value.startswith("```json"):
        value = value[len("```json") :]
    if value.startswith("```"):
        value = value[len("```") :]
    if value.endswith("```"):
        value = value[: -len("```")]
    value = value.strip()
    start = value.find("{")
    end = value.rfind("}")
    if start >= 0 and end > start:
        value = value[start : end + 1]
    data = json.loads(value)
    raw_steps = data.get("steps") or []
    if not raw_steps:
        raise ValueError("no steps in plan")
    steps = [
        PlanStep(
            id=step.get("id", ""),
            title=step.get("title", ""),
            type=step.get("type", ""),
            needs_approval=bool(step.get("needs_approval", False)),
            command=step.get("command"),
            patch=step.get("patch"),
        )
        for step in raw_steps
    ]
    return Plan(steps=steps)


def _build_planning_prompt(spec_text: str, bundle: "ContextBundle") -> str:
    out = ""
    out += "You are an expert coding-agent planner.\n"
    out += "Return JSON ONLY (no markdown, no code fences) with this exact schema:\n\n"
    out += '{"steps":[{"id":"step_...","title":"...","type":"command|patch|diagram|note","needs_approval":true|false,"command":"...","patch":"..."}]}\n\n'
    out += "Rules:\n"
    out += "- Use needs_approval=true for any destructive command or infra change.\n"
    out += "- Use type=patch with a unified diff in patch when you propose code edits.\n"
    out += "- Keep the step list short and executable.\n\n"
    out += "SPEC:\n"
    out += spec_text + "\n\n"
    if getattr(bundle, "agents_md", None):
        out += "AGENTS.md:\n" + (bundle.agents_md or "") + "\n\n"
    if getattr(bundle, "repo_map", None):
        out += "REPO MAP (symbols):\n" + (bundle.repo_map or "") + "\n\n"
    if getattr(bundle, "git_status", None):
        out += "GIT STATUS:\n" + (bundle.git_status or "") + "\n\n"
    return out


def _normalize_plan(plan: Plan) -> None:
    for step in plan.steps:
        if not step.id.strip():
            step.id = new_step_id()
        if not step.title.strip():
            step.title = step.type
        if not step.type.strip():
            step.type = "note"
