from __future__ import annotations

import copy
import io
import json
import threading
import zipfile
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

from internal.util.cancel import CancelToken, CanceledError
from internal.util.id import (
    new_attachment_id,
    new_run_id,
    new_session_id,
    new_turn_id,
)
from .models import Event, Run, Step
from .session_models import ApprovalDecision, Message, Session, SessionEvent, Turn


class ApprovalWaiter:
    def __init__(self) -> None:
        self.event = threading.Event()

    def resolve(self) -> None:
        self.event.set()


class SessionApprovalWaiter:
    def __init__(self) -> None:
        self.event = threading.Event()
        self.decision: Optional[ApprovalDecision] = None

    def resolve(self, decision: ApprovalDecision) -> None:
        self.decision = decision
        self.event.set()


class Store:
    def __init__(self, data_dir: str) -> None:
        self._data_dir = Path(data_dir)
        self._runs: Dict[str, Run] = {}
        self._sessions: Dict[str, Session] = {}
        self._subs: Dict[str, set[Callable[[Event], None]]] = {}
        self._session_subs: Dict[str, set[Callable[[SessionEvent], None]]] = {}
        self._approvals: Dict[str, Dict[str, ApprovalWaiter]] = {}
        self._session_approvals: Dict[str, Dict[str, SessionApprovalWaiter]] = {}
        self._cancels: Dict[str, CancelToken] = {}
        self._session_cancels: Dict[str, CancelToken] = {}
        self._lock = threading.RLock()

    def data_directory(self) -> str:
        return str(self._data_dir)

    def init(self) -> None:
        if not str(self._data_dir):
            raise ValueError("data_dir is empty")
        (self._data_dir / "runs").mkdir(parents=True, exist_ok=True)
        (self._data_dir / "sessions").mkdir(parents=True, exist_ok=True)
        self._load_existing()

    def _load_existing(self) -> None:
        self._load_existing_runs()
        self._load_existing_sessions()

    def _load_existing_runs(self) -> None:
        runs_dir = self._data_dir / "runs"
        if not runs_dir.exists():
            return
        for entry in runs_dir.iterdir():
            run_path = entry / "run.json"
            try:
                raw = run_path.read_text(encoding="utf-8")
                run = _run_from_dict(json.loads(raw))
                self._runs[run.id] = run
            except Exception:
                continue

    def _load_existing_sessions(self) -> None:
        sessions_dir = self._data_dir / "sessions"
        if not sessions_dir.exists():
            return
        for entry in sessions_dir.iterdir():
            session_path = entry / "session.json"
            try:
                raw = session_path.read_text(encoding="utf-8")
                session = _session_from_dict(json.loads(raw))
                self._sessions[session.id] = session
            except Exception:
                continue

    def _run_dir(self, run_id: str) -> Path:
        return self._data_dir / "runs" / run_id

    def _run_path(self, run_id: str) -> Path:
        return self._run_dir(run_id) / "run.json"

    def _events_path(self, run_id: str) -> Path:
        return self._run_dir(run_id) / "events.ndjson"

    def create_run(self, workspace_path: str, spec_path: str) -> Run:
        if not workspace_path.strip():
            raise ValueError("workspace_path is empty")
        if not spec_path.strip():
            raise ValueError("spec_path is empty")
        run = Run(
            id=new_run_id(),
            created_at=_now(),
            updated_at=_now(),
            status="queued",
            workspace_path=workspace_path,
            spec_path=spec_path,
        )
        run_dir = self._run_dir(run.id)
        run_dir.mkdir(parents=True, exist_ok=True)
        self._events_path(run.id).write_text("", encoding="utf-8")
        self._save_run(run)
        with self._lock:
            self._runs[run.id] = run
        self.append_event(
            run.id,
            Event(
                ts=_now(),
                run_id=run.id,
                type="run_created",
                data={"workspace_path": workspace_path, "spec_path": spec_path},
            ),
        )
        return copy.deepcopy(run)

    def _save_run(self, run: Run) -> None:
        run.updated_at = _now()
        payload = json.dumps(asdict(run), indent=2) + "\n"
        self._run_path(run.id).write_text(payload, encoding="utf-8")

    def update_run(self, run: Run) -> None:
        if not run:
            raise ValueError("run is nil")
        with self._lock:
            self._runs[run.id] = run
        self._save_run(run)

    def get_run(self, run_id: str) -> Run:
        with self._lock:
            run = self._runs.get(run_id)
            if not run:
                raise KeyError(f"run not found: {run_id}")
            return copy.deepcopy(run)

    def list_runs(self) -> List[Run]:
        with self._lock:
            runs = list(self._runs.values())
        runs.sort(key=lambda r: r.created_at, reverse=True)
        return [copy.deepcopy(run) for run in runs]

    def append_event(self, run_id: str, ev: Event) -> None:
        event = Event(
            ts=_normalize_ts(ev.ts),
            run_id=ev.run_id or run_id,
            type=ev.type,
            message=ev.message,
            data=ev.data,
        )
        line = json.dumps(asdict(event)) + "\n"
        with self._events_path(run_id).open("a", encoding="utf-8") as handle:
            handle.write(line)
        subs = []
        with self._lock:
            if run_id in self._subs:
                subs = list(self._subs[run_id])
        for handler in subs:
            handler(event)

    def subscribe(self, run_id: str, handler: Callable[[Event], None]) -> Callable[[], None]:
        with self._lock:
            if run_id not in self._subs:
                self._subs[run_id] = set()
            self._subs[run_id].add(handler)

        def _unsubscribe() -> None:
            with self._lock:
                if run_id in self._subs:
                    self._subs[run_id].discard(handler)

        return _unsubscribe

    def read_events(self, run_id: str, max_items: int) -> List[Event]:
        path = self._events_path(run_id)
        out: List[Event] = []
        if not path.exists():
            return out
        with path.open("r", encoding="utf-8") as handle:
            for raw in handle:
                line = raw.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    out.append(Event(**data))
                except Exception:
                    continue
                if max_items > 0 and len(out) >= max_items:
                    break
        return out

    def require_approval(self, run_id: str, step_id: str) -> None:
        if not run_id or not step_id:
            raise ValueError("run_id and step_id required")
        with self._lock:
            if run_id not in self._approvals:
                self._approvals[run_id] = {}
            if step_id in self._approvals[run_id]:
                raise ValueError(f"approval already pending for step {step_id}")
            self._approvals[run_id][step_id] = ApprovalWaiter()

    def approve(self, run_id: str, step_id: str) -> None:
        with self._lock:
            entry = self._approvals.get(run_id, {}).get(step_id)
            if not entry:
                raise ValueError(f"no approval pending for step {step_id}")
            entry.resolve()
            del self._approvals[run_id][step_id]

    def wait_for_approval(self, run_id: str, step_id: str, signal: CancelToken | None = None) -> None:
        with self._lock:
            entry = self._approvals.get(run_id, {}).get(step_id)
        if not entry:
            raise ValueError(f"no approval pending for step {step_id}")
        if not signal:
            entry.event.wait()
            return
        while True:
            if entry.event.wait(timeout=0.1):
                return
            if signal.is_cancelled():
                raise signal.reason or CanceledError("aborted")

    def set_run_cancel(self, run_id: str, token: CancelToken) -> None:
        with self._lock:
            self._cancels[run_id] = token

    def cancel_run(self, run_id: str) -> None:
        with self._lock:
            token = self._cancels.get(run_id)
        if token:
            token.cancel()

    def export_run(self, run_id: str) -> bytes:
        run_dir = self._run_dir(run_id)
        if not run_dir.exists():
            raise FileNotFoundError(str(run_dir))
        files: Dict[str, bytes] = {}
        files["run.json"] = self._run_path(run_id).read_bytes()
        files["events.ndjson"] = self._events_path(run_id).read_bytes()
        artifacts_dir = run_dir / "artifacts"
        self._add_dir_to_zip(run_dir, artifacts_dir, files)
        return _zip_bytes(files)

    # Session helpers
    def _sessions_dir(self) -> Path:
        return self._data_dir / "sessions"

    def _session_dir(self, session_id: str) -> Path:
        return self._sessions_dir() / session_id

    def _session_path(self, session_id: str) -> Path:
        return self._session_dir(session_id) / "session.json"

    def _session_events_path(self, session_id: str) -> Path:
        return self._session_dir(session_id) / "events.ndjson"

    def _session_attachments_dir(self, session_id: str) -> Path:
        return self._session_dir(session_id) / "attachments"

    def _session_artifacts_dir(self, session_id: str, turn_id: str) -> Path:
        return self._session_dir(session_id) / "artifacts" / turn_id

    def create_session(self, workspace_path: str, system_prompt: str, mode: str, spec_path: str) -> Session:
        if not workspace_path.strip():
            raise ValueError("workspace_path is empty")
        session = Session(
            id=new_session_id(),
            created_at=_now(),
            updated_at=_now(),
            status="active",
            mode=mode or "chat",
            workspace_path=workspace_path,
            system_prompt=system_prompt.strip() if system_prompt else "",
            spec_path=spec_path.strip() if spec_path else "",
            messages=[],
            turns=[],
        )
        dir_path = self._session_dir(session.id)
        dir_path.mkdir(parents=True, exist_ok=True)
        self._session_events_path(session.id).write_text("", encoding="utf-8")
        self._save_session(session)
        with self._lock:
            self._sessions[session.id] = session
        self.append_session_event(
            session.id,
            SessionEvent(
                ts=_now(),
                session_id=session.id,
                type="session_created",
                data={"workspace_path": workspace_path},
            ),
        )
        return copy.deepcopy(session)

    def _save_session(self, session: Session) -> None:
        session.updated_at = _now()
        payload = json.dumps(asdict(session), indent=2) + "\n"
        self._session_path(session.id).write_text(payload, encoding="utf-8")

    def update_session(self, session: Session) -> None:
        if not session:
            raise ValueError("session is nil")
        with self._lock:
            self._sessions[session.id] = session
        self._save_session(session)

    def get_session(self, session_id: str) -> Session:
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                raise KeyError(f"session not found: {session_id}")
            return copy.deepcopy(session)

    def list_sessions(self) -> List[Session]:
        with self._lock:
            sessions = list(self._sessions.values())
        sessions.sort(key=lambda s: s.created_at, reverse=True)
        return [copy.deepcopy(session) for session in sessions]

    def append_message(self, session_id: str, msg: Message) -> Session:
        session = self.get_session(session_id)
        session.messages = session.messages or []
        session.messages.append(msg)
        self.update_session(session)
        return session

    def add_turn(self, session_id: str) -> str:
        session = self.get_session(session_id)
        turn = Turn(id=new_turn_id(), status="pending")
        session.turns = session.turns or []
        session.turns.append(turn)
        session.last_turn_id = turn.id
        self.update_session(session)
        return turn.id

    def append_session_event(self, session_id: str, ev: SessionEvent) -> None:
        event = SessionEvent(
            ts=_normalize_ts(ev.ts),
            session_id=ev.session_id or session_id,
            turn_id=ev.turn_id,
            type=ev.type,
            message=ev.message,
            data=ev.data,
        )
        line = json.dumps(asdict(event)) + "\n"
        with self._session_events_path(session_id).open("a", encoding="utf-8") as handle:
            handle.write(line)
        subs = []
        with self._lock:
            if session_id in self._session_subs:
                subs = list(self._session_subs[session_id])
        for handler in subs:
            handler(event)

    def subscribe_session(self, session_id: str, handler: Callable[[SessionEvent], None]) -> Callable[[], None]:
        with self._lock:
            if session_id not in self._session_subs:
                self._session_subs[session_id] = set()
            self._session_subs[session_id].add(handler)

        def _unsubscribe() -> None:
            with self._lock:
                if session_id in self._session_subs:
                    self._session_subs[session_id].discard(handler)

        return _unsubscribe

    def read_session_events(self, session_id: str, max_items: int) -> List[SessionEvent]:
        path = self._session_events_path(session_id)
        out: List[SessionEvent] = []
        if not path.exists():
            return out
        with path.open("r", encoding="utf-8") as handle:
            for raw in handle:
                line = raw.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    out.append(SessionEvent(**data))
                except Exception:
                    continue
                if max_items > 0 and len(out) >= max_items:
                    break
        return out

    def save_session_attachment(self, session_id: str, filename: str, mime_type: str, content: bytes) -> Dict[str, str]:
        if not session_id:
            raise ValueError("session_id required")
        dir_path = self._session_attachments_dir(session_id)
        dir_path.mkdir(parents=True, exist_ok=True)
        name = (filename or "").strip() or new_attachment_id()
        name = Path(name).name
        if name in (".", "/"):
            name = new_attachment_id()
        if not mime_type:
            mime_type = "application/octet-stream"
        ext = Path(name).suffix
        if not ext:
            name = f"{name}.bin"
        target = dir_path / name
        if target.exists():
            name = f"{new_attachment_id()}{ext}"
            target = dir_path / name
        target.write_bytes(content)
        return {"ref": f"attachments/{name}", "mime_type": mime_type}

    def require_session_approval(self, session_id: str, tool_call_id: str) -> None:
        if not session_id or not tool_call_id:
            raise ValueError("session_id and tool_call_id required")
        with self._lock:
            if session_id not in self._session_approvals:
                self._session_approvals[session_id] = {}
            if tool_call_id in self._session_approvals[session_id]:
                raise ValueError(f"approval already pending for tool call {tool_call_id}")
            self._session_approvals[session_id][tool_call_id] = SessionApprovalWaiter()

    def approve_session_tool_call(self, session_id: str, tool_call_id: str, decision: ApprovalDecision) -> None:
        with self._lock:
            entry = self._session_approvals.get(session_id, {}).get(tool_call_id)
            if not entry:
                raise ValueError(f"no approval pending for tool call {tool_call_id}")
            entry.resolve(decision)
            del self._session_approvals[session_id][tool_call_id]

    def wait_for_session_approval(self, session_id: str, tool_call_id: str, signal: CancelToken | None = None) -> ApprovalDecision:
        with self._lock:
            entry = self._session_approvals.get(session_id, {}).get(tool_call_id)
        if not entry:
            raise ValueError(f"no approval pending for tool call {tool_call_id}")
        if not signal:
            entry.event.wait()
            return entry.decision or ApprovalDecision(action="approve")
        while True:
            if entry.event.wait(timeout=0.1):
                return entry.decision or ApprovalDecision(action="approve")
            if signal.is_cancelled():
                raise signal.reason or CanceledError("aborted")

    def set_session_cancel(self, session_id: str, token: CancelToken) -> None:
        with self._lock:
            self._session_cancels[session_id] = token

    def cancel_session(self, session_id: str) -> None:
        with self._lock:
            token = self._session_cancels.get(session_id)
        if token:
            token.cancel()
        try:
            session = self.get_session(session_id)
        except KeyError:
            return
        if session.status in ("active", "waiting_approval"):
            session.status = "canceled"
            if not session.error:
                session.error = "canceled"
            self.update_session(session)

    def export_session(self, session_id: str) -> bytes:
        dir_path = self._session_dir(session_id)
        if not dir_path.exists():
            raise FileNotFoundError(str(dir_path))
        files: Dict[str, bytes] = {}
        files["session.json"] = self._session_path(session_id).read_bytes()
        files["events.ndjson"] = self._session_events_path(session_id).read_bytes()
        self._add_dir_to_zip(dir_path, dir_path / "attachments", files)
        self._add_dir_to_zip(dir_path, dir_path / "artifacts", files)
        return _zip_bytes(files)

    def session_artifacts_path(self, session_id: str, turn_id: str, name: str) -> str:
        return str(self._session_artifacts_dir(session_id, turn_id) / name)

    def ensure_session_artifacts_dir(self, session_id: str, turn_id: str) -> None:
        self._session_artifacts_dir(session_id, turn_id).mkdir(parents=True, exist_ok=True)

    def _add_dir_to_zip(self, root: Path, dir_path: Path, files: Dict[str, bytes]) -> None:
        if not dir_path.exists() or not dir_path.is_dir():
            return
        for entry in dir_path.iterdir():
            if entry.is_dir():
                self._add_dir_to_zip(root, entry, files)
                continue
            if not entry.is_file():
                continue
            rel = entry.relative_to(root).as_posix()
            files[rel] = entry.read_bytes()


def _zip_bytes(files: Dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_ts(ts: str) -> str:
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc).isoformat()
    except Exception:
        return _now()


def _step_from_dict(data: dict) -> Step:
    return Step(
        id=data.get("id", ""),
        title=data.get("title", ""),
        type=data.get("type", ""),
        needs_approval=bool(data.get("needs_approval", False)),
        command=data.get("command"),
        status=data.get("status", "pending"),
        started_at=data.get("started_at"),
        completed_at=data.get("completed_at"),
    )


def _run_from_dict(data: dict) -> Run:
    steps = data.get("steps") or []
    return Run(
        id=data.get("id", ""),
        created_at=data.get("created_at", ""),
        updated_at=data.get("updated_at", ""),
        status=data.get("status", "queued"),
        workspace_path=data.get("workspace_path", ""),
        spec_path=data.get("spec_path", ""),
        model_canonical=data.get("model_canonical"),
        steps=[_step_from_dict(step) for step in steps] if steps else None,
        error=data.get("error"),
    )


def _message_part_from_dict(data: dict):
    from .session_models import MessagePart

    return MessagePart(
        type=data.get("type", ""),
        text=data.get("text"),
        ref=data.get("ref"),
        mime_type=data.get("mime_type"),
        tool_call_id=data.get("tool_call_id"),
        tool_name=data.get("tool_name"),
        tool_input=data.get("tool_input"),
    )


def _message_from_dict(data: dict):
    return Message(
        id=data.get("id", ""),
        role=data.get("role", ""),
        parts=[_message_part_from_dict(p) for p in data.get("parts", [])],
        created_at=data.get("created_at", ""),
        tool_call_id=data.get("tool_call_id"),
    )


def _turn_from_dict(data: dict) -> Turn:
    return Turn(
        id=data.get("id", ""),
        status=data.get("status", "pending"),
        started_at=data.get("started_at"),
        completed_at=data.get("completed_at"),
        error=data.get("error"),
    )


def _session_from_dict(data: dict) -> Session:
    messages = data.get("messages") or []
    turns = data.get("turns") or []
    return Session(
        id=data.get("id", ""),
        created_at=data.get("created_at", ""),
        updated_at=data.get("updated_at", ""),
        status=data.get("status", "active"),
        mode=data.get("mode"),
        workspace_path=data.get("workspace_path", ""),
        system_prompt=data.get("system_prompt"),
        spec_path=data.get("spec_path"),
        last_turn_id=data.get("last_turn_id"),
        messages=[_message_from_dict(m) for m in messages] if messages else None,
        turns=[_turn_from_dict(t) for t in turns] if turns else None,
        error=data.get("error"),
    )
