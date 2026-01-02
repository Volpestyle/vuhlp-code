from __future__ import annotations

import tempfile
from datetime import datetime, timezone
from pathlib import Path

from internal.runstore import Store
from internal.runstore.models import Event
from internal.runstore.session_models import SessionEvent


def _temp_dir() -> str:
    return tempfile.mkdtemp(prefix="harness-")


def test_create_run_append_event_export() -> None:
    tmp = _temp_dir()
    store = Store(tmp)
    store.init()

    ws = Path(tmp) / "ws"
    ws.mkdir(parents=True, exist_ok=True)
    spec = Path(tmp) / "spec.md"
    spec.write_text("# spec", encoding="utf-8")

    run = store.create_run(str(ws), str(spec))
    assert run.id

    store.append_event(
        run.id,
        Event(ts=datetime.now(timezone.utc).isoformat(), run_id=run.id, type="log", message="hello"),
    )

    events = store.read_events(run.id, 10)
    assert len(events) > 0

    zip_data = store.export_run(run.id)
    assert len(zip_data) > 0


def test_create_session_append_event_export() -> None:
    tmp = _temp_dir()
    store = Store(tmp)
    store.init()

    ws = Path(tmp) / "ws"
    ws.mkdir(parents=True, exist_ok=True)

    session = store.create_session(str(ws), "system prompt", "", "")
    assert session.id

    store.append_session_event(
        session.id,
        SessionEvent(ts=datetime.now(timezone.utc).isoformat(), session_id=session.id, type="message_added"),
    )

    events = store.read_session_events(session.id, 10)
    assert len(events) > 0

    attachment = store.save_session_attachment(session.id, "note.txt", "text/plain", b"hi")
    assert attachment["ref"]

    zip_data = store.export_session(session.id)
    assert len(zip_data) > 0
