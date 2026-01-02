from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from internal.api.server import Server
from internal.runstore import Store


def _temp_dir() -> str:
    return tempfile.mkdtemp(prefix="harness-")


class DummyRunner:
    def start_run(self, run_id: str) -> None:
        return None


class DummySessionRunner:
    def start_turn(self, session_id: str, turn_id: str) -> None:
        return None


class DummySpecGen:
    def generate_spec(self, workspace_path: str, spec_name: str, prompt: str) -> str:
        return "# spec\n"


def test_create_run() -> None:
    tmp = _temp_dir()
    store = Store(tmp)
    store.init()

    ws = Path(tmp) / "ws"
    spec = Path(tmp) / "spec.md"
    ws.mkdir(parents=True, exist_ok=True)
    spec.write_text("# spec", encoding="utf-8")

    server = Server(store, "", DummyRunner())
    client = TestClient(server.handler())
    res = client.post("/v1/runs", json={"workspace_path": str(ws), "spec_path": str(spec)})
    assert res.status_code == 200


def test_create_session() -> None:
    tmp = _temp_dir()
    store = Store(tmp)
    store.init()

    ws = Path(tmp) / "ws"
    ws.mkdir(parents=True, exist_ok=True)

    server = Server(store, "", None, DummySessionRunner())
    client = TestClient(server.handler())
    res = client.post("/v1/sessions", json={"workspace_path": str(ws)})
    assert res.status_code == 200


def test_create_session_spec_mode_default_path() -> None:
    tmp = _temp_dir()
    store = Store(tmp)
    store.init()

    ws = Path(tmp) / "ws"
    ws.mkdir(parents=True, exist_ok=True)

    server = Server(store, "", None, DummySessionRunner())
    client = TestClient(server.handler())
    res = client.post("/v1/sessions", json={"workspace_path": str(ws), "mode": "spec"})
    assert res.status_code == 200
    body = res.json()
    assert body.get("spec_path")
    assert Path(body["spec_path"]).exists()


def test_generate_spec() -> None:
    tmp = _temp_dir()
    store = Store(tmp)
    store.init()

    ws = Path(tmp) / "ws"
    ws.mkdir(parents=True, exist_ok=True)

    server = Server(store, "", None, None, DummySpecGen())
    client = TestClient(server.handler())
    res = client.post(
        "/v1/specs/generate",
        json={"workspace_path": str(ws), "spec_name": "my-spec", "prompt": "do thing"},
    )
    assert res.status_code == 200
    assert (ws / "specs" / "my-spec" / "spec.md").exists()
