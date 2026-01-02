from __future__ import annotations

import asyncio
import json
import time
import base64
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

from internal.config import ModelPolicy
from internal.runstore import Store
from internal.runstore.models import Event
from internal.runstore.session_models import Message, MessagePart, SessionEvent
from internal.util.files import default_walk_options, walk_files
from internal.util.id import new_message_id
from internal.util.json import error_response
from internal.util.spec import default_spec_path, ensure_spec_file
from .dashboard import handle_dashboard


class RunStarter:
    def start_run(self, run_id: str) -> None:
        raise NotImplementedError


class SessionTurnStarter:
    def start_turn(self, session_id: str, turn_id: str) -> None:
        raise NotImplementedError


class SpecGenerator:
    def generate_spec(self, workspace_path: str, spec_name: str, prompt: str) -> str:
        raise NotImplementedError


class ModelService:
    def list_models(self):
        raise NotImplementedError

    def get_policy(self) -> ModelPolicy:
        raise NotImplementedError

    def set_policy(self, policy: ModelPolicy) -> None:
        raise NotImplementedError


class Server:
    def __init__(
        self,
        store: Store,
        auth_token: str,
        runner: Optional[RunStarter] = None,
        session_runner: Optional[SessionTurnStarter] = None,
        spec_gen: Optional[SpecGenerator] = None,
        model_svc: Optional[ModelService] = None,
    ) -> None:
        self._store = store
        self._auth_token = auth_token
        self._runner = runner
        self._session_runner = session_runner
        self._spec_gen = spec_gen
        self._model_svc = model_svc
        self._app = FastAPI()
        self._configure_middleware()
        self._configure_routes()

    def handler(self) -> FastAPI:
        return self._app

    def _configure_middleware(self) -> None:
        self._app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type"],
        )

        @self._app.middleware("http")
        async def recover_middleware(request: Request, call_next):
            try:
                return await call_next(request)
            except Exception:
                return Response(status_code=500)

        @self._app.middleware("http")
        async def auth_middleware(request: Request, call_next):
            if not self._auth_token.strip():
                return await call_next(request)
            auth = request.headers.get("authorization") or ""
            prefix = "Bearer "
            if not auth.startswith(prefix) or auth[len(prefix) :].strip() != self._auth_token:
                return Response(status_code=401)
            return await call_next(request)

        @self._app.middleware("http")
        async def logging_middleware(request: Request, call_next):
            start = time.time()
            response = await call_next(request)
            duration = int((time.time() - start) * 1000)
            print(
                "http",
                {
                    "method": request.method,
                    "path": request.url.path,
                    "ua": request.headers.get("user-agent", ""),
                    "duration_ms": duration,
                },
            )
            return response

    def _configure_routes(self) -> None:
        @self._app.get("/healthz")
        async def healthz():
            return {"ok": True}

        @self._app.get("/hello")
        async def hello():
            return {"message": "hello"}

        @self._app.get("/v1/runs")
        async def list_runs():
            return self._store.list_runs()

        @self._app.post("/v1/runs")
        async def create_run(request: Request):
            try:
                body = await _parse_json(request)
            except ValueError:
                return error_response("invalid json", 400)
            try:
                run = self._store.create_run(body.get("workspace_path", ""), body.get("spec_path", ""))
                if self._runner:
                    self._runner.start_run(run.id)
                return {"run_id": run.id}
            except Exception as err:
                return error_response(str(err), 400)

        @self._app.get("/v1/runs/{run_id}")
        async def get_run(run_id: str):
            try:
                return self._store.get_run(run_id)
            except Exception as err:
                return error_response(str(err), 404)

        @self._app.get("/v1/runs/{run_id}/events")
        async def run_events(request: Request, run_id: str):
            async def stream():
                history = self._store.read_events(run_id, 200)
                for ev in history:
                    yield _format_sse("message", ev)
                queue: asyncio.Queue[str] = asyncio.Queue()
                loop = asyncio.get_running_loop()

                def handler(ev):
                    loop.call_soon_threadsafe(queue.put_nowait, _format_sse("message", ev))

                unsubscribe = self._store.subscribe(run_id, handler)
                keepalive = asyncio.create_task(_keepalive(queue))
                try:
                    while True:
                        if await request.is_disconnected():
                            break
                        payload = await queue.get()
                        yield payload
                finally:
                    unsubscribe()
                    keepalive.cancel()

            return StreamingResponse(
                stream(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
            )

        @self._app.post("/v1/runs/{run_id}/approve")
        async def approve_run(request: Request, run_id: str):
            try:
                body = await _parse_json(request)
            except ValueError:
                return error_response("invalid json", 400)
            step_id = body.get("step_id", "")
            if not step_id:
                return error_response("step_id required", 400)
            try:
                self._store.approve(run_id, step_id)
                self._store.append_event(
                    run_id,
                    Event(
                        ts=_now(),
                        run_id=run_id,
                        type="approval_granted",
                        data={"step_id": step_id},
                    ),
                )
                return {"ok": True}
            except Exception as err:
                return error_response(str(err), 400)

        @self._app.post("/v1/runs/{run_id}/cancel")
        async def cancel_run(run_id: str):
            self._store.cancel_run(run_id)
            self._store.append_event(
                run_id,
                Event(ts=_now(), run_id=run_id, type="run_cancel_requested"),
            )
            return {"ok": True}

        @self._app.get("/v1/runs/{run_id}/export")
        async def export_run(run_id: str):
            try:
                data = self._store.export_run(run_id)
            except Exception as err:
                return error_response(str(err), 500)
            headers = {
                "Content-Type": "application/zip",
                "Content-Disposition": f"attachment; filename=\"{run_id}.zip\"",
            }
            return Response(content=data, headers=headers, media_type="application/zip")

        @self._app.get("/v1/sessions")
        async def list_sessions():
            return self._store.list_sessions()

        @self._app.post("/v1/sessions")
        async def create_session(request: Request):
            try:
                body = await _parse_json(request)
            except ValueError:
                return error_response("invalid json", 400)
            mode = (body.get("mode") or "chat").strip() or "chat"
            spec_path = (body.get("spec_path") or "").strip()
            if spec_path:
                try:
                    spec_path = _resolve_spec_path(body.get("workspace_path", ""), spec_path)
                except Exception as err:
                    return error_response(str(err), 400)
            try:
                session = self._store.create_session(
                    body.get("workspace_path", ""),
                    body.get("system_prompt", ""),
                    mode,
                    spec_path,
                )
                if session.mode == "spec" and not (session.spec_path or "").strip():
                    default_path = default_spec_path(session.workspace_path, f"session-{session.id}")
                    session.spec_path = default_path
                    self._store.update_session(session)
                    self._store.append_session_event(
                        session.id,
                        SessionEvent(
                            ts=_now(),
                            session_id=session.id,
                            type="spec_path_set",
                            data={"spec_path": session.spec_path},
                        ),
                    )
                    created = ensure_spec_file(session.spec_path)
                    if created:
                        self._store.append_session_event(
                            session.id,
                            SessionEvent(
                                ts=_now(),
                                session_id=session.id,
                                type="spec_created",
                                data={"spec_path": session.spec_path},
                            ),
                        )
                return {"session_id": session.id, "spec_path": session.spec_path}
            except Exception as err:
                return error_response(str(err), 400)

        @self._app.get("/v1/sessions/{session_id}")
        async def get_session(session_id: str):
            try:
                return self._store.get_session(session_id)
            except Exception as err:
                return error_response(str(err), 404)

        @self._app.post("/v1/sessions/{session_id}/mode")
        async def session_mode(request: Request, session_id: str):
            try:
                body = await _parse_json(request)
            except ValueError:
                return error_response("invalid json", 400)
            mode = (body.get("mode") or "").strip()
            if not mode:
                return error_response("mode is required", 400)
            if mode not in ("chat", "spec"):
                return error_response("mode must be chat or spec", 400)
            try:
                session = self._store.get_session(session_id)
            except Exception as err:
                return error_response(str(err), 404)
            spec_path = (body.get("spec_path") or "").strip()
            if mode == "spec":
                if spec_path:
                    try:
                        spec_path = _resolve_spec_path(session.workspace_path, spec_path)
                    except Exception as err:
                        return error_response(str(err), 400)
                elif not (session.spec_path or "").strip():
                    spec_path = default_spec_path(session.workspace_path, f"session-{session.id}")
                else:
                    spec_path = session.spec_path or ""
            elif spec_path:
                try:
                    spec_path = _resolve_spec_path(session.workspace_path, spec_path)
                except Exception as err:
                    return error_response(str(err), 400)
            session.mode = mode
            if spec_path.strip():
                session.spec_path = spec_path
            self._store.update_session(session)
            self._store.append_session_event(
                session_id,
                SessionEvent(
                    ts=_now(),
                    session_id=session.id,
                    type="session_mode_set",
                    data={"mode": session.mode, "spec_path": session.spec_path},
                ),
            )
            if session.mode == "spec" and (session.spec_path or "").strip():
                created = ensure_spec_file(session.spec_path)
                if created:
                    self._store.append_session_event(
                        session_id,
                        SessionEvent(
                            ts=_now(),
                            session_id=session.id,
                            type="spec_created",
                            data={"spec_path": session.spec_path},
                        ),
                    )
            return {"session_id": session.id, "mode": session.mode, "spec_path": session.spec_path}

        @self._app.post("/v1/sessions/{session_id}/messages")
        async def session_message(request: Request, session_id: str):
            try:
                body = await _parse_json(request)
            except ValueError:
                return error_response("invalid json", 400)
            role = (body.get("role") or "").strip()
            if not role:
                return error_response("role required", 400)
            parts = body.get("parts") or []
            msg = Message(
                id=new_message_id(),
                role=role,
                parts=[
                    MessagePart(
                        type=part.get("type"),
                        text=part.get("text"),
                        ref=part.get("ref"),
                        mime_type=part.get("mime_type"),
                    )
                    for part in parts
                ],
                created_at=_now(),
            )
            try:
                self._store.append_message(session_id, msg)
            except Exception as err:
                return error_response(str(err), 400)
            self._store.append_session_event(
                session_id,
                SessionEvent(
                    ts=_now(),
                    session_id=session_id,
                    type="message_added",
                    data={"message_id": msg.id, "role": msg.role},
                ),
            )
            turn_id = self._store.add_turn(session_id)
            auto_run = body.get("auto_run")
            if auto_run is None or auto_run is True:
                if not self._session_runner:
                    return error_response("session runner not configured", 500)
                self._session_runner.start_turn(session_id, turn_id)
            return {"message_id": msg.id, "turn_id": turn_id}

        @self._app.post("/v1/sessions/{session_id}/approve")
        async def session_approve(request: Request, session_id: str):
            try:
                body = await _parse_json(request)
            except ValueError:
                return error_response("invalid json", 400)
            tool_call_id = (body.get("tool_call_id") or "").strip()
            if not tool_call_id:
                return error_response("tool_call_id required", 400)
            action = (body.get("action") or "approve").strip()
            try:
                self._store.approve_session_tool_call(
                    session_id,
                    tool_call_id,
                    {"action": action, "reason": body.get("reason")},
                )
                self._store.append_session_event(
                    session_id,
                    SessionEvent(
                        ts=_now(),
                        session_id=session_id,
                        turn_id=body.get("turn_id"),
                        type="approval_denied" if action == "deny" else "approval_granted",
                        data={"tool_call_id": tool_call_id, "reason": body.get("reason")},
                    ),
                )
                return {"ok": True}
            except Exception as err:
                return error_response(str(err), 400)

        @self._app.post("/v1/sessions/{session_id}/cancel")
        async def session_cancel(session_id: str):
            self._store.cancel_session(session_id)
            self._store.append_session_event(
                session_id,
                SessionEvent(ts=_now(), session_id=session_id, type="session_canceled"),
            )
            return {"ok": True}

        @self._app.post("/v1/sessions/{session_id}/attachments")
        async def session_attachment(request: Request, session_id: str):
            content_type = request.headers.get("content-type") or ""
            if content_type.startswith("multipart/form-data"):
                form = await request.form()
                file = form.get("file")
                if not file:
                    return error_response("file required", 400)
                data = await file.read()
                name = file.filename
                mime_type = file.content_type
                ref = self._store.save_session_attachment(session_id, name, mime_type, data)
                return {"ref": ref["ref"], "mime_type": ref["mime_type"]}
            try:
                body = await _parse_json(request)
            except ValueError:
                return error_response("invalid json", 400)
            content_b64 = (body.get("content_base64") or "").strip()
            if not content_b64:
                return error_response("content_base64 required", 400)
            try:
                content = base64.b64decode(content_b64)
            except Exception:
                return error_response("invalid base64 content", 400)
            ref = self._store.save_session_attachment(
                session_id,
                body.get("name") or "",
                body.get("mime_type") or "",
                content,
            )
            return {"ref": ref["ref"], "mime_type": ref["mime_type"]}

        @self._app.get("/v1/sessions/{session_id}/events")
        async def session_events(request: Request, session_id: str):
            if request.query_params.get("format") == "json":
                max_items = int(request.query_params.get("max") or 0)
                events = self._store.read_session_events(session_id, max_items if max_items > 0 else 0)
                return events

            async def stream():
                history = self._store.read_session_events(session_id, 200)
                for ev in history:
                    yield _format_sse("message", ev)
                queue: asyncio.Queue[str] = asyncio.Queue()
                loop = asyncio.get_running_loop()

                def handler(ev):
                    loop.call_soon_threadsafe(queue.put_nowait, _format_sse("message", ev))

                unsubscribe = self._store.subscribe_session(session_id, handler)
                keepalive = asyncio.create_task(_keepalive(queue))
                try:
                    while True:
                        if await request.is_disconnected():
                            break
                        payload = await queue.get()
                        yield payload
                finally:
                    unsubscribe()
                    keepalive.cancel()

            return StreamingResponse(
                stream(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
            )

        @self._app.post("/v1/sessions/{session_id}/turns/{turn_id}/retry")
        async def session_retry(session_id: str, turn_id: str):
            if not self._session_runner:
                return error_response("session runner not configured", 500)
            self._session_runner.start_turn(session_id, turn_id)
            return {"ok": True}

        @self._app.post("/v1/specs/generate")
        async def generate_spec(request: Request):
            if not self._spec_gen:
                return error_response("spec generator not configured", 500)
            try:
                body = await _parse_json(request)
            except ValueError:
                return error_response("invalid json", 400)
            workspace = (body.get("workspace_path") or "").strip()
            spec_name = (body.get("spec_name") or "").strip()
            prompt = (body.get("prompt") or "").strip()
            if not workspace or not spec_name or not prompt:
                return error_response("workspace_path, spec_name, and prompt are required", 400)
            if not _is_safe_spec_name(spec_name):
                return error_response("spec_name must be alphanumeric with dashes or underscores", 400)
            try:
                info = Path(workspace)
                if not info.is_dir():
                    return error_response("workspace_path must be a directory", 400)
            except Exception:
                return error_response("workspace_path must be a directory", 400)

            spec_rel = Path("specs") / spec_name / "spec.md"
            try:
                spec_abs = _safe_workspace_join(workspace, spec_rel.as_posix())
            except Exception as err:
                return error_response(str(err), 400)
            if not body.get("overwrite"):
                if Path(spec_abs).exists():
                    return error_response("spec already exists", 409)
            content = self._spec_gen.generate_spec(workspace, spec_name, prompt)
            Path(spec_abs).parent.mkdir(parents=True, exist_ok=True)
            diag_dir = Path(spec_abs).parent / "diagrams"
            diag_dir.mkdir(parents=True, exist_ok=True)
            Path(spec_abs).write_text(content, encoding="utf-8")
            return {"spec_path": spec_abs, "content": content}

        @self._app.get("/v1/models")
        async def list_models():
            if not self._model_svc:
                return error_response("model service not configured", 500)
            models = self._model_svc.list_models()
            return {"models": models, "policy": self._model_svc.get_policy()}

        @self._app.get("/v1/model-policy")
        async def get_model_policy():
            if not self._model_svc:
                return error_response("model service not configured", 500)
            return self._model_svc.get_policy()

        @self._app.post("/v1/model-policy")
        async def set_model_policy(request: Request):
            if not self._model_svc:
                return error_response("model service not configured", 500)
            try:
                data = await _parse_json(request)
            except ValueError:
                return error_response("invalid json", 400)
            policy = ModelPolicy(
                require_tools=bool(data.get("require_tools", False)),
                require_vision=bool(data.get("require_vision", False)),
                max_cost_usd=float(data.get("max_cost_usd", 5.0)),
                preferred_models=list(data.get("preferred_models", [])),
            )
            self._model_svc.set_policy(policy)
            return self._model_svc.get_policy()

        @self._app.get("/v1/workspace/tree")
        async def workspace_tree(request: Request):
            workspace = (request.query_params.get("workspace_path") or "").strip()
            if not workspace:
                return error_response("workspace_path required", 400)
            try:
                info = Path(workspace)
                if not info.is_dir():
                    raise ValueError()
            except Exception:
                return error_response("workspace_path must be a directory", 400)
            opts = default_walk_options()
            opts.max_files = 800
            opts.max_depth = 8
            files = walk_files(workspace, opts)
            return {"root": workspace, "files": files}

        @self._app.get("/")
        async def dashboard_root(request: Request):
            return handle_dashboard(request)

        @self._app.get("/{path:path}")
        async def dashboard_catchall(request: Request, path: str):
            if request.url.path.startswith("/v1/"):
                return Response("not found", status_code=404)
            return handle_dashboard(request)


async def _keepalive(queue: asyncio.Queue[str]) -> None:
    while True:
        await asyncio.sleep(15)
        queue.put_nowait(": keep-alive\n\n")


def _format_sse(event: str, data: object) -> str:
    payload = _to_jsonable(data)
    return f"event: {event}\ndata: {json.dumps(payload)}\n\n"


def _to_jsonable(value: object) -> object:
    try:
        from dataclasses import asdict, is_dataclass
    except Exception:
        is_dataclass = None
    if is_dataclass and is_dataclass(value):
        return asdict(value)
    if hasattr(value, "__dict__"):
        return dict(value.__dict__)
    return value


def _is_safe_spec_name(name: str) -> bool:
    if not name:
        return False
    for ch in name:
        if ch.isalnum() or ch in "-_":
            continue
        return False
    return True


def _safe_workspace_join(workspace: str, rel: str) -> str:
    root = Path(workspace).resolve()
    abs_path = (root / rel).resolve()
    try:
        rel_path = abs_path.relative_to(root)
    except Exception as err:
        raise ValueError(f"path escapes workspace: {rel}") from err
    return str(abs_path)


def _resolve_spec_path(workspace: str, spec_path: str) -> str:
    if not spec_path.strip():
        raise ValueError("spec_path is empty")
    root = Path(workspace).resolve()
    path = Path(spec_path)
    if path.is_absolute():
        abs_path = path.resolve()
        try:
            abs_path.relative_to(root)
        except Exception:
            raise ValueError(f"spec_path escapes workspace: {spec_path}")
        return str(abs_path)
    return _safe_workspace_join(str(root), spec_path)


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


async def _parse_json(request: Request) -> dict:
    body = await request.body()
    try:
        return json.loads(body)
    except Exception as err:
        raise ValueError("invalid json") from err
