from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from internal.config import ModelPolicy

if TYPE_CHECKING:
    from ai_kit import Kit, ModelRecord
    from ai_kit.router import ModelRouter


class SpecGenerator:
    def __init__(self, kit: "Kit", policy: ModelPolicy, router: "ModelRouter") -> None:
        self._kit = kit
        self._policy = policy
        self._router = router

    def generate_spec(self, workspace_path: str, spec_name: str, prompt: str) -> str:
        if not self._kit:
            raise ValueError("kit is nil")
        model = self._resolve_model()
        agents = ""
        try:
            agents = (Path(workspace_path) / "AGENTS.md").read_text(encoding="utf-8")
        except Exception:
            pass
        sys_prompt = _build_spec_prompt(spec_name, prompt, agents)

        from ai_kit import GenerateInput, Message, ContentPart

        output = self._kit.generate(
            GenerateInput(
                provider=model.provider,
                model=model.providerModelId,
                messages=[Message(role="user", content=[ContentPart(type="text", text=sys_prompt)])],
            )
        )
        content = (output.text or "").strip()
        if not content:
            raise RuntimeError("model returned empty spec")
        if "# Goal" not in content:
            content = _fallback_spec(spec_name, prompt)
        if not content.endswith("\n"):
            content += "\n"
        return content

    def _resolve_model(self) -> "ModelRecord":
        from ai_kit import ModelConstraints, ModelResolutionRequest

        records = self._kit.list_model_records()
        resolved = self._router.resolve(
            records,
            ModelResolutionRequest(
                constraints=ModelConstraints(
                    requireTools=self._policy.require_tools,
                    requireVision=self._policy.require_vision,
                    maxCostUsd=self._policy.max_cost_usd,
                ),
                preferredModels=self._policy.preferred_models,
            ),
        )
        return resolved.primary


def _build_spec_prompt(name: str, prompt: str, agents: str) -> str:
    out = ""
    out += "You are an expert product/spec writer for a coding agent harness.\n"
    out += "Return ONLY markdown (no code fences, no commentary).\n"
    out += "Follow this exact structure:\n"
    out += "---\n"
    out += f"name: {name}\n"
    out += "owner: you\n"
    out += "status: draft\n"
    out += "---\n\n"
    out += "# Goal\n\n"
    out += "<one paragraph goal>\n\n"
    out += "# Constraints / nuances\n\n"
    out += "- <bullets>\n\n"
    out += "# Acceptance tests\n\n"
    out += "- <bulleted, runnable checks>\n\n"
    out += "# Notes\n\n"
    out += "- <optional>\n\n"
    out += "USER PROMPT:\n" + prompt + "\n\n"
    if agents.strip():
        out += "AGENTS.md:\n" + agents + "\n\n"
    return out


def _fallback_spec(name: str, prompt: str) -> str:
    return (
        "---\n"
        f"name: {name}\n"
        "owner: you\n"
        "status: draft\n"
        "---\n\n"
        "# Goal\n\n"
        f"{prompt.strip()}\n\n"
        "# Constraints / nuances\n\n"
        "- Follow repo conventions in AGENTS.md.\n\n"
        "# Acceptance tests\n\n"
        "- make test\n"
    )
