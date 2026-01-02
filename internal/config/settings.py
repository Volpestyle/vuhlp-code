from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .config import ModelPolicy


@dataclass
class Settings:
    model_policy: ModelPolicy


def _default_policy() -> ModelPolicy:
    return ModelPolicy(require_tools=False, require_vision=False, max_cost_usd=5.0, preferred_models=[])


def load_settings(file_path: str) -> tuple[Settings, bool]:
    if not file_path:
        raise ValueError("path is empty")
    path = Path(file_path)
    if not path.exists():
        return Settings(model_policy=_default_policy()), False
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    policy_raw = data.get("model_policy") or {}
    settings = Settings(
        model_policy=ModelPolicy(
            require_tools=bool(policy_raw.get("require_tools", False)),
            require_vision=bool(policy_raw.get("require_vision", False)),
            max_cost_usd=float(policy_raw.get("max_cost_usd", 5.0)),
            preferred_models=list(policy_raw.get("preferred_models", [])),
        )
    )
    return settings, True


def save_settings(file_path: str, settings: Settings) -> None:
    if not file_path:
        raise ValueError("path is empty")
    path = Path(file_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "model_policy": {
            "require_tools": settings.model_policy.require_tools,
            "require_vision": settings.model_policy.require_vision,
            "max_cost_usd": settings.model_policy.max_cost_usd,
            "preferred_models": settings.model_policy.preferred_models,
        }
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
