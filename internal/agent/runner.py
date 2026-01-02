from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from internal.config import ModelPolicy
from internal.runstore import Store
from internal.runstore.models import Run, Step
from internal.util.cancel import CancelToken
from internal.util.exec import ExecOptions, run_command
from internal.util.patch import apply_unified_diff
from internal.util.spec import ensure_spec_file
from .context import gather_context
from .plan import PlanStep, generate_plan

if TYPE_CHECKING:
    from ai_kit import Kit, ModelRecord
    from ai_kit.router import ModelRouter


class Runner:
    def __init__(self, store: Store, kit: "Kit", policy: ModelPolicy, router: "ModelRouter") -> None:
        self._store = store
        self._kit = kit
        self._policy = policy
        self._router = router
        self._running: set[str] = set()
        self._lock = threading.Lock()

    def set_policy(self, policy: ModelPolicy) -> None:
        self._policy = policy

    def start_run(self, run_id: str) -> None:
        with self._lock:
            if run_id in self._running:
                return
            self._running.add(run_id)
        token = CancelToken()
        self._store.set_run_cancel(run_id, token)
        thread = threading.Thread(target=self._execute, args=(run_id, token), daemon=True)
        thread.start()

    def _execute(self, run_id: str, token: CancelToken) -> None:
        try:
            run = self._store.get_run(run_id)
            run.status = "running"
            self._store.update_run(run)
            self._store.append_event(run_id, _event(run_id, "run_started", "run started"))

            created = ensure_spec_file(run.spec_path)
            if created:
                self._store.append_event(run_id, _event(run_id, "spec_created", data={"spec_path": run.spec_path}))

            spec_text = Path(run.spec_path).read_text(encoding="utf-8")
            self._store.append_event(
                run_id,
                _event(run_id, "spec_loaded", data={"bytes": len(spec_text)}),
            )

            bundle = gather_context(run.workspace_path, token)
            self._store.append_event(
                run_id,
                _event(
                    run_id,
                    "context_gathered",
                    data={
                        "has_agents_md": bool(bundle.agents_md),
                        "repo_tree_len": len(bundle.repo_tree.split("\n")) if bundle.repo_tree else 0,
                        "repo_map_len": len(bundle.repo_map.split("\n")) if bundle.repo_map else 0,
                    },
                ),
            )

            model = self._resolve_model()
            run.model_canonical = model.id
            self._store.update_run(run)
            self._store.append_event(run_id, _event(run_id, "model_resolved", data={"model": model.id}))

            plan = generate_plan(self._kit, model, spec_text, bundle)
            self._store.append_event(run_id, _event(run_id, "plan_generated", data={"steps": len(plan.steps)}))

            run.steps = [
                Step(
                    id=step.id,
                    title=step.title,
                    type=step.type,
                    needs_approval=step.needs_approval,
                    command=step.command,
                    status="pending",
                )
                for step in plan.steps
            ]
            self._store.update_run(run)

            for step in plan.steps:
                if token.is_cancelled():
                    self._cancel_run(run_id, token.reason or RuntimeError("canceled"))
                    return
                self._execute_step(run_id, step, token)

            run = self._store.get_run(run_id)
            run.status = "succeeded"
            run.error = ""
            self._store.update_run(run)
            self._store.append_event(run_id, _event(run_id, "run_succeeded", "run completed successfully"))
        except Exception as err:
            self._fail_run(run_id, err)
            raise
        finally:
            with self._lock:
                self._running.discard(run_id)

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

    def _execute_step(self, run_id: str, step: PlanStep, token: CancelToken) -> None:
        self._store.append_event(
            run_id,
            _event(
                run_id,
                "step_started",
                data={"step_id": step.id, "title": step.title, "type": step.type},
            ),
        )
        run = self._store.get_run(run_id)
        for item in run.steps or []:
            if item.id == step.id:
                item.status = "running"
                item.started_at = _now()
        self._store.update_run(run)

        if step.needs_approval:
            run.status = "waiting_approval"
            for item in run.steps or []:
                if item.id == step.id:
                    item.status = "waiting_approval"
            self._store.update_run(run)
            self._store.require_approval(run_id, step.id)
            self._store.append_event(
                run_id,
                _event(run_id, "approval_requested", data={"step_id": step.id, "title": step.title}),
            )
            self._store.wait_for_approval(run_id, step.id, token)
            run = self._store.get_run(run_id)
            run.status = "running"
            for item in run.steps or []:
                if item.id == step.id:
                    item.status = "running"
            self._store.update_run(run)

        step_type = (step.type or "").lower()
        if step_type == "command":
            self._exec_command_step(run_id, step, token)
        elif step_type == "patch":
            self._exec_patch_step(run_id, step, token)
        elif step_type == "diagram":
            self._exec_command_step(
                run_id,
                PlanStep(
                    id=step.id,
                    title=step.title,
                    type="command",
                    needs_approval=step.needs_approval,
                    command="make diagrams",
                ),
                token,
            )
        else:
            self._complete_step(run_id, step.id, True, "")

    def _exec_command_step(self, run_id: str, step: PlanStep, token: CancelToken) -> None:
        run = self._store.get_run(run_id)
        if not (step.command or "").strip():
            self._complete_step(run_id, step.id, True, "no command (skipped)")
            return
        ok = True
        result: object
        try:
            result = run_command(
                step.command,
                ExecOptions(dir=run.workspace_path, timeout_ms=30 * 60_000, signal=token),
            )
        except Exception as err:
            ok = False
            result = getattr(err, "result", None) or {"error": str(err)}
        artifact_path = self._write_artifact(run_id, step.id, "command.json", json.dumps(_as_dict(result), indent=2))
        exit_code = _as_dict(result).get("exit_code", 1)
        self._store.append_event(
            run_id,
            _event(
                run_id,
                "command_executed",
                data={
                    "step_id": step.id,
                    "cmd": step.command,
                    "exit_code": exit_code,
                    "artifact_rel": artifact_path,
                },
            ),
        )
        if not ok:
            self._complete_step(run_id, step.id, False, "command failed")
            raise RuntimeError("command failed")
        self._complete_step(run_id, step.id, True, "")

    def _exec_patch_step(self, run_id: str, step: PlanStep, token: CancelToken) -> None:
        run = self._store.get_run(run_id)
        if not (step.patch or "").strip():
            self._complete_step(run_id, step.id, True, "no patch (skipped)")
            return
        ok = True
        result: object
        try:
            result = apply_unified_diff(run.workspace_path, step.patch or "", signal=token)
        except Exception as err:
            ok = False
            result = getattr(err, "result", None) or {"applied": False, "error": str(err)}
        artifact_path = self._write_artifact(
            run_id,
            step.id,
            "patch_apply.json",
            json.dumps(_as_dict(result), indent=2),
        )
        self._store.append_event(
            run_id,
            _event(
                run_id,
                "patch_applied",
                data={
                    "step_id": step.id,
                    "applied": _as_dict(result).get("applied", False),
                    "artifact_rel": artifact_path,
                },
            ),
        )
        if not ok:
            self._complete_step(run_id, step.id, False, "patch apply error")
            raise RuntimeError("patch apply error")
        self._complete_step(run_id, step.id, True, "")

    def _complete_step(self, run_id: str, step_id: str, ok: bool, msg: str) -> None:
        run = self._store.get_run(run_id)
        for item in run.steps or []:
            if item.id == step_id:
                item.completed_at = _now()
                item.status = "succeeded" if ok else "failed"
        self._store.update_run(run)
        self._store.append_event(
            run_id,
            _event(
                run_id,
                "step_completed" if ok else "step_failed",
                message=msg,
                data={"step_id": step_id, "ok": ok},
            ),
        )

    def _write_artifact(self, run_id: str, step_id: str, name: str, content: str) -> str:
        base = Path(self._store.data_directory()) / "runs" / run_id / "artifacts" / step_id
        base.mkdir(parents=True, exist_ok=True)
        target = base / name
        text = content if content.endswith("\n") else content + "\n"
        target.write_text(text, encoding="utf-8")
        return str(Path("artifacts") / step_id / name).replace("\\", "/")

    def _fail_run(self, run_id: str, err: Exception) -> None:
        run = self._store.get_run(run_id)
        run.status = "failed"
        run.error = str(err)
        self._store.update_run(run)
        self._store.append_event(run_id, _event(run_id, "run_failed", str(err)))

    def _cancel_run(self, run_id: str, err: Exception) -> None:
        run = self._store.get_run(run_id)
        run.status = "canceled"
        run.error = ""
        self._store.update_run(run)
        self._store.append_event(run_id, _event(run_id, "run_canceled", str(err)))


def _event(run_id: str, event_type: str, message: str | None = None, data: dict | None = None):
    from internal.runstore.models import Event

    return Event(ts=_now(), run_id=run_id, type=event_type, message=message, data=data)


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _as_dict(value: object) -> dict:
    if hasattr(value, "__dict__"):
        return dict(value.__dict__)
    if isinstance(value, dict):
        return value
    return {"value": value}
