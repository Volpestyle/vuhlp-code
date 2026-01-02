from __future__ import annotations

import fnmatch
import hashlib
import json
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional

from internal.util.cancel import CancelToken


@dataclass
class SymbolEntry:
    file: str
    line: int
    name: str
    kind: str
    language: Optional[str] = None


def build_repo_map(
    workspace: str,
    files: List[str],
    max_symbols: int,
    signal: CancelToken | None = None,
) -> str:
    entries = _load_or_build_index(workspace, files, signal)
    entries = _sort_entries(entries)
    if max_symbols > 0:
        entries = entries[:max_symbols]
    return _format_entries(entries)


def query_symbol_index(
    workspace: str,
    files: List[str],
    query: str,
    glob: str,
    kind: str,
    language: str,
    max_results: int,
    signal: CancelToken | None = None,
) -> List[SymbolEntry]:
    entries = _load_or_build_index(workspace, files, signal)
    if not entries:
        return []
    if not max_results or max_results <= 0:
        max_results = 50
    needle = (query or "").strip().lower()
    kind = (kind or "").strip().lower()
    language = (language or "").strip().lower()
    filtered: List[SymbolEntry] = []
    for entry in _sort_entries(entries):
        if glob and not fnmatch.fnmatch(entry.file, glob):
            continue
        if kind and entry.kind.lower() != kind:
            continue
        if language and (entry.language or "").lower() != language:
            continue
        if needle and needle not in entry.name.lower() and needle not in entry.file.lower():
            continue
        filtered.append(entry)
        if len(filtered) >= max_results:
            break
    return filtered


def _load_or_build_index(
    workspace: str,
    files: List[str],
    signal: CancelToken | None,
) -> List[SymbolEntry]:
    workspace_path = Path(workspace).resolve()
    _require_ctags()
    index_path, meta_path = _index_paths(workspace_path)
    fingerprint = _compute_fingerprint(workspace_path, files)
    meta = _load_meta(meta_path)
    if meta and meta.get("fingerprint") == fingerprint and index_path.exists():
        return _load_index_entries(index_path)

    entries = _build_ctags_index(workspace_path, files, signal)
    _write_index_entries(index_path, entries)
    _write_meta(meta_path, fingerprint, "ctags")
    return entries


def _index_paths(workspace: Path) -> tuple[Path, Path]:
    cache_dir = workspace / ".agent-harness-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / "symbols.jsonl", cache_dir / "symbols.meta.json"


def _compute_fingerprint(workspace: Path, files: List[str]) -> str:
    hasher = hashlib.sha256()
    for rel in sorted(files):
        path = workspace / rel
        try:
            stat = path.stat()
        except OSError:
            continue
        hasher.update(rel.encode("utf-8"))
        hasher.update(str(stat.st_mtime_ns).encode("utf-8"))
        hasher.update(str(stat.st_size).encode("utf-8"))
    return hasher.hexdigest()


def _load_meta(path: Path) -> Optional[dict]:
    try:
        raw = path.read_text(encoding="utf-8")
        return json.loads(raw)
    except Exception:
        return None


def _write_meta(path: Path, fingerprint: str, source: str) -> None:
    payload = {
        "fingerprint": fingerprint,
        "source": source,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _load_index_entries(path: Path) -> List[SymbolEntry]:
    entries: List[SymbolEntry] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for raw in handle:
                line = raw.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except Exception:
                    continue
                entry = SymbolEntry(
                    file=data.get("file", ""),
                    line=int(data.get("line") or 0),
                    name=data.get("name", ""),
                    kind=data.get("kind", ""),
                    language=data.get("language"),
                )
                if entry.file and entry.name:
                    entries.append(entry)
    except Exception:
        return []
    return entries


def _write_index_entries(path: Path, entries: Iterable[SymbolEntry]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for entry in entries:
            payload = {
                "file": entry.file,
                "line": entry.line,
                "name": entry.name,
                "kind": entry.kind,
                "language": entry.language,
            }
            handle.write(json.dumps(payload) + "\n")


def _require_ctags() -> str:
    ctags = shutil.which("ctags")
    if not ctags:
        raise RuntimeError("ctags is required; install universal-ctags and ensure it is on PATH")
    return ctags


def _build_ctags_index(
    workspace: Path,
    files: List[str],
    signal: CancelToken | None,
) -> List[SymbolEntry]:
    if not files:
        return []
    ctags = _require_ctags()

    list_path = workspace / ".agent-harness-cache" / "symbols.files"
    try:
        list_path.write_text(
            "\n".join(str(workspace / rel) for rel in files),
            encoding="utf-8",
        )
    except Exception:
        return []

    cmd = [
        ctags,
        "--output-format=json",
        "--fields=+n",
        "--excmd=number",
        "--sort=no",
        "-f",
        "-",
        "-L",
        str(list_path),
    ]

    entries: List[SymbolEntry] = []
    process = subprocess.Popen(
        cmd,
        cwd=str(workspace),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    cancel_lock = threading.Lock()

    def kill() -> None:
        with cancel_lock:
            if process.poll() is None:
                process.kill()

    if signal:
        def watch_cancel() -> None:
            signal.wait()
            kill()
        threading.Thread(target=watch_cancel, daemon=True).start()

    if process.stdout:
        for raw in process.stdout:
            line = raw.strip()
            if not line:
                continue
            entry = _parse_ctags_json(line, workspace)
            if entry:
                entries.append(entry)

    if process.stderr:
        stderr = process.stderr.read().strip()
    else:
        stderr = ""

    exit_code = process.wait()
    if exit_code != 0:
        detail = f": {stderr}" if stderr else ""
        raise RuntimeError(f"ctags failed with exit code {exit_code}{detail}")
    return entries


def _parse_ctags_json(raw: str, workspace: Path) -> Optional[SymbolEntry]:
    try:
        data = json.loads(raw)
    except Exception:
        return None
    if data.get("_type") not in (None, "tag"):
        return None
    name = data.get("name") or ""
    path = data.get("path") or data.get("file") or ""
    if not name or not path:
        return None
    kind = data.get("kind_long") or data.get("kind") or ""
    line = int(data.get("line") or data.get("lineNumber") or 0)
    language = data.get("language")

    try:
        rel = Path(path).resolve().relative_to(workspace)
        file_path = rel.as_posix()
    except Exception:
        file_path = str(Path(path))
    return SymbolEntry(file=file_path, line=line, name=name, kind=kind, language=language)


def _sort_entries(entries: List[SymbolEntry]) -> List[SymbolEntry]:
    return sorted(entries, key=lambda entry: (entry.file, entry.line, entry.name))


def _format_entries(entries: List[SymbolEntry]) -> str:
    out: List[str] = []
    last_file = ""
    for entry in entries:
        if entry.file != last_file:
            if last_file:
                out.append("")
            out.append(f"{entry.file}:")
            last_file = entry.file
        label = entry.kind
        if entry.language:
            label = f"{label} [{entry.language}]"
        out.append(f"  - {label} {entry.name} (line {entry.line})")
    return "\n".join(out).strip()
