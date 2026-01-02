from __future__ import annotations

from typing import TYPE_CHECKING, List

from internal.config import ModelPolicy
from internal.config.settings import save_settings, Settings

if TYPE_CHECKING:
    from ai_kit import Kit, ModelRecord
    from .runner import Runner
    from .session_runner import SessionRunner


class ModelService:
    def __init__(
        self,
        kit: "Kit",
        policy: ModelPolicy,
        settings_path: str,
        runner: "Runner" | None = None,
        session_runner: "SessionRunner" | None = None,
    ) -> None:
        self._kit = kit
        self._policy = policy
        self._settings_path = settings_path
        self._runner = runner
        self._session_runner = session_runner

    def list_models(self) -> List["ModelRecord"]:
        if not self._kit:
            return []
        return self._kit.list_model_records()

    def get_policy(self) -> ModelPolicy:
        return self._policy

    def set_policy(self, policy: ModelPolicy) -> None:
        self._policy = policy
        if self._runner:
            self._runner.set_policy(policy)
        if self._session_runner:
            self._session_runner.set_policy(policy)
        save_settings(self._settings_path, Settings(model_policy=policy))
