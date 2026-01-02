from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import List

from internal.util.path import expand_home


@dataclass
class ModelPolicy:
    require_tools: bool = False
    require_vision: bool = False
    max_cost_usd: float = 5.0
    preferred_models: List[str] = field(default_factory=list)


@dataclass
class Config:
    listen_addr: str = "127.0.0.1:8787"
    data_dir: str = "~/.agent-harness"
    auth_token: str = ""
    model_policy: ModelPolicy = field(default_factory=ModelPolicy)


def default_config() -> Config:
    return Config()


def load_from_file(file_path: str) -> Config:
    if not file_path:
        raise ValueError("path is empty")
    raw = Path(file_path).read_text(encoding="utf-8")
    data = json.loads(raw)
    policy_raw = data.get("model_policy") or {}
    policy = ModelPolicy(
        require_tools=bool(policy_raw.get("require_tools", False)),
        require_vision=bool(policy_raw.get("require_vision", False)),
        max_cost_usd=float(policy_raw.get("max_cost_usd", 5.0)),
        preferred_models=list(policy_raw.get("preferred_models", [])),
    )
    return Config(
        listen_addr=str(data.get("listen_addr", "127.0.0.1:8787")),
        data_dir=str(data.get("data_dir", "~/.agent-harness")),
        auth_token=str(data.get("auth_token", "")),
        model_policy=policy,
    )


def expand_config_home(cfg: Config) -> Config:
    cfg.data_dir = expand_home(cfg.data_dir)
    return cfg
