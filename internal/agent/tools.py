from __future__ import annotations

import json
import os
import fnmatch
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Protocol

from internal.runstore.session_models import MessagePart
from internal.util.exec import ExecOptions, run_command
from internal.util.files import default_walk_options, walk_files
from internal.util.patch import apply_unified_diff
from .context import build_repo_map

ToolKind = str


@dataclass
class ToolDefinition:
    name: str
    description: str
    kind: ToolKind
    parameters: Optional[Dict[str, object]] = None
    requires_approval: bool = False
    allow_without_approval: bool = False


@dataclass
class ToolCall:
    id: str
    name: str
    input: str


@dataclass
class ToolResult:
    id: str
    ok: bool
    parts: List[MessagePart]
    artifacts: Optional[List[str]] = None
    error: Optional[str] = None


class Tool(Protocol):
    def definition(self) -> ToolDefinition:
        ...

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        ...


class ToolRegistry(Protocol):
    def definitions(self) -> List[ToolDefinition]:
        ...

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        ...

    def get(self, name: str) -> Optional[Tool]:
        ...

    def add(self, tool: Tool) -> None:
        ...


class Registry:
    def __init__(self, *tools: Tool) -> None:
        self._tools: Dict[str, Tool] = {}
        for tool in tools:
            self.add(tool)

    def add(self, tool: Tool) -> None:
        if not tool:
            return
        self._tools[tool.definition().name] = tool

    def definitions(self) -> List[ToolDefinition]:
        return sorted(
            (tool.definition() for tool in self._tools.values()),
            key=lambda d: d.name,
        )

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        tool = self._tools.get(call.name)
        if not tool:
            return ToolResult(id=call.id, ok=False, error="unknown tool", parts=[])
        return tool.invoke(call, signal)

    def get(self, name: str) -> Optional[Tool]:
        return self._tools.get(name)


def default_tool_registry(workspace: str, commands: List[str]) -> ToolRegistry:
    verify_commands = commands or ["make test"]
    return Registry(
        RepoTreeTool(workspace, 500),
        RepoMapTool(workspace, 400),
        ReadFileTool(workspace, 400),
        SearchTool(workspace, 50),
        GitStatusTool(workspace),
        ApplyPatchTool(workspace),
        ShellTool(workspace, 30 * 60_000),
        DiagramTool(workspace),
        VerifyTool(workspace, verify_commands, 30 * 60_000),
    )


class AikitAdapter:
    def to_aikit_tools(self, defs: List[ToolDefinition]):
        from ai_kit import ToolDefinition as AikitToolDefinition

        out = []
        for definition in defs:
            out.append(
                AikitToolDefinition(
                    name=definition.name,
                    description=definition.description,
                    parameters=definition.parameters
                    or {
                        "type": "object",
                        "properties": {},
                    },
                )
            )
        return out

    def from_aikit_call(self, call) -> ToolCall:
        raw = _normalize_tool_input(getattr(call, "argumentsJson", "") or "")
        return ToolCall(id=call.id, name=call.name, input=raw)


def _safe_workspace_path(workspace: str, rel: str) -> str:
    if not rel.strip():
        raise ValueError("path is empty")
    root = Path(workspace).resolve()
    abs_path = (root / rel).resolve()
    rel_path = os.path.relpath(abs_path, root)
    if rel_path == ".." or rel_path.startswith(".." + os.sep):
        raise ValueError(f"path escapes workspace: {rel}")
    return str(abs_path)


def _to_json(value: object) -> str:
    return json.dumps(value, indent=2, default=str)


def _normalize_tool_input(raw: str) -> str:
    trimmed = raw.strip()
    if not trimmed:
        return "{}"
    if _is_valid_json(trimmed):
        return trimmed
    candidate = _extract_last_json_object(trimmed)
    if candidate and _is_valid_json(candidate):
        return candidate
    return trimmed


def _is_valid_json(value: str) -> bool:
    try:
        json.loads(value)
        return True
    except Exception:
        return False


def _extract_last_json_object(value: str) -> Optional[str]:
    depth = 0
    end = -1
    for i in range(len(value) - 1, -1, -1):
        ch = value[i]
        if ch == "}":
            if depth == 0:
                end = i
            depth += 1
            continue
        if ch == "{":
            if depth > 0:
                depth -= 1
                if depth == 0 and end != -1:
                    return value[i : end + 1]
    return None


class RepoTreeTool:
    def __init__(self, workspace: str, max_files: int) -> None:
        self._workspace = workspace
        self._max_files = max_files

    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="repo_tree",
            description="List files in the workspace (relative paths).",
            kind="read",
            parameters={"type": "object", "properties": {"max_files": {"type": "integer"}}},
        )

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        max_files = self._max_files
        try:
            payload = json.loads(call.input or "{}")
            if payload.get("max_files"):
                max_files = int(payload.get("max_files"))
        except Exception:
            pass
        files = walk_files(self._workspace, default_walk_options())
        slice_ = files[: max_files if max_files > 0 else None]
        text = "\n".join(slice_) if slice_ else "workspace contains no files"
        return ToolResult(id=call.id, ok=True, parts=[MessagePart(type="text", text=text)])


class RepoMapTool:
    def __init__(self, workspace: str, max_symbols: int) -> None:
        self._workspace = workspace
        self._max_symbols = max_symbols

    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="repo_map",
            description="List symbols in the repo (Go/Python/JS/TS).",
            kind="read",
            parameters={"type": "object", "properties": {"max_symbols": {"type": "integer"}}},
        )

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        max_symbols = self._max_symbols
        try:
            payload = json.loads(call.input or "{}")
            if payload.get("max_symbols"):
                max_symbols = int(payload.get("max_symbols"))
        except Exception:
            pass
        if max_symbols <= 0:
            max_symbols = 400
        files = walk_files(self._workspace, default_walk_options())
        out = build_repo_map(self._workspace, files, max_symbols)
        return ToolResult(id=call.id, ok=True, parts=[MessagePart(type="text", text=out)])


class ReadFileTool:
    def __init__(self, workspace: str, max_lines: int) -> None:
        self._workspace = workspace
        self._max_lines = max_lines

    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="read_file",
            description="Read a file from the workspace with optional line range.",
            kind="read",
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "start_line": {"type": "integer"},
                    "end_line": {"type": "integer"},
                },
                "required": ["path"],
            },
        )

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        try:
            payload = json.loads(call.input or "{}")
        except Exception:
            return ToolResult(id=call.id, ok=False, error="invalid input", parts=[])
        abs_path = _safe_workspace_path(self._workspace, payload.get("path", ""))
        content = Path(abs_path).read_text(encoding="utf-8", errors="ignore")
        lines = content.split("\n")
        start = int(payload.get("start_line") or 1)
        end = int(payload.get("end_line") or len(lines))
        if start < 1:
            start = 1
        if end > len(lines):
            end = len(lines)
        if start > end:
            start = end
        if self._max_lines > 0 and (end - start + 1) > self._max_lines:
            end = min(len(lines), start + self._max_lines - 1)
        snippet = "\n".join(lines[start - 1 : end])
        return ToolResult(id=call.id, ok=True, parts=[MessagePart(type="text", text=snippet)])


class SearchTool:
    def __init__(self, workspace: str, max_results: int) -> None:
        self._workspace = workspace
        self._max_results = max_results

    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="search",
            description="Search for a substring in files.",
            kind="read",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "glob": {"type": "string"},
                    "max_results": {"type": "integer"},
                },
                "required": ["query"],
            },
        )

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        try:
            payload = json.loads(call.input or "{}")
        except Exception:
            return ToolResult(id=call.id, ok=False, error="invalid input", parts=[])
        query = (payload.get("query") or "").strip()
        if not query:
            return ToolResult(id=call.id, ok=False, error="query required", parts=[])
        max_results = int(payload.get("max_results") or self._max_results)
        if max_results <= 0:
            max_results = 50
        glob = payload.get("glob")
        files = walk_files(self._workspace, default_walk_options())
        matches: List[str] = []
        for rel in files:
            if len(matches) >= max_results:
                break
            if glob and not fnmatch.fnmatch(Path(rel).name, glob):
                continue
            abs_path = Path(self._workspace) / rel
            try:
                content = abs_path.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            lines = content.split("\n")
            for idx, line in enumerate(lines, start=1):
                if len(matches) >= max_results:
                    break
                if query in line:
                    matches.append(f"{rel}:{idx}:{line.strip()}")
        return ToolResult(id=call.id, ok=True, parts=[MessagePart(type="text", text="\n".join(matches))])


class GitStatusTool:
    def __init__(self, workspace: str) -> None:
        self._workspace = workspace

    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="git_status",
            description="Return git status --porcelain for the workspace.",
            kind="read",
            parameters={"type": "object", "properties": {}},
        )

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        try:
            res = run_command("git status --porcelain", ExecOptions(dir=self._workspace, timeout_ms=10_000, signal=signal))
            return ToolResult(id=call.id, ok=True, parts=[MessagePart(type="text", text=res.stdout.strip())])
        except Exception as err:
            result = getattr(err, "result", None)
            stdout = getattr(result, "stdout", "") if result else ""
            return ToolResult(id=call.id, ok=False, error=str(err), parts=[MessagePart(type="text", text=stdout)])


class ApplyPatchTool:
    def __init__(self, workspace: str) -> None:
        self._workspace = workspace

    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="apply_patch",
            description="Apply a unified diff patch using git apply.",
            kind="write",
            requires_approval=True,
            parameters={
                "type": "object",
                "properties": {"patch": {"type": "string"}},
                "required": ["patch"],
            },
        )

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        try:
            payload = json.loads(call.input or "{}")
        except Exception:
            return ToolResult(id=call.id, ok=False, error="invalid input", parts=[])
        try:
            result = apply_unified_diff(self._workspace, payload.get("patch", ""), signal=signal)
            return ToolResult(id=call.id, ok=True, parts=[MessagePart(type="text", text=_to_json(result.__dict__))])
        except Exception as err:
            result = getattr(err, "result", None)
            data = result.__dict__ if result else {"applied": False}
            return ToolResult(id=call.id, ok=False, error=str(err), parts=[MessagePart(type="text", text=_to_json(data))])


class ShellTool:
    def __init__(self, workspace: str, timeout_ms: int) -> None:
        self._workspace = workspace
        self._timeout_ms = timeout_ms

    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="shell",
            description="Run a shell command in the workspace.",
            kind="exec",
            requires_approval=True,
            parameters={
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "timeout_seconds": {"type": "integer"},
                },
                "required": ["command"],
            },
        )

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        try:
            payload = json.loads(call.input or "{}")
        except Exception:
            return ToolResult(id=call.id, ok=False, error="invalid input", parts=[])
        timeout = int(payload.get("timeout_seconds") or 0)
        timeout_ms = timeout * 1000 if timeout else self._timeout_ms
        try:
            res = run_command(payload.get("command", ""), ExecOptions(dir=self._workspace, timeout_ms=timeout_ms, signal=signal))
            return ToolResult(id=call.id, ok=True, parts=[MessagePart(type="text", text=_to_json(res.__dict__))])
        except Exception as err:
            result = getattr(err, "result", None)
            data = result.__dict__ if result else {}
            return ToolResult(id=call.id, ok=False, error=str(err), parts=[MessagePart(type="text", text=_to_json(data))])


class DiagramTool:
    def __init__(self, workspace: str) -> None:
        self._workspace = workspace

    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="diagram",
            description="Render diagrams using make diagrams.",
            kind="exec",
            requires_approval=True,
            parameters={"type": "object", "properties": {}},
        )

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        try:
            res = run_command("make diagrams", ExecOptions(dir=self._workspace, timeout_ms=30 * 60_000, signal=signal))
            return ToolResult(id=call.id, ok=True, parts=[MessagePart(type="text", text=_to_json(res.__dict__))])
        except Exception as err:
            result = getattr(err, "result", None)
            data = result.__dict__ if result else {}
            return ToolResult(id=call.id, ok=False, error=str(err), parts=[MessagePart(type="text", text=_to_json(data))])


class VerifyTool:
    def __init__(self, workspace: str, commands: List[str], timeout_ms: int) -> None:
        self._workspace = workspace
        self._commands = commands
        self._timeout_ms = timeout_ms

    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="verify",
            description="Run verification commands.",
            kind="exec",
            parameters={"type": "object", "properties": {}},
        )

    def invoke(self, call: ToolCall, signal=None) -> ToolResult:
        if not self._commands:
            self._commands = ["make test"]
        results: List[Dict[str, object]] = []
        ok = True
        for cmd in self._commands:
            try:
                res = run_command(cmd, ExecOptions(dir=self._workspace, timeout_ms=self._timeout_ms, signal=signal))
                results.append(
                    {
                        "cmd": res.cmd,
                        "exit_code": res.exit_code,
                        "stdout": res.stdout,
                        "stderr": res.stderr,
                        "duration": res.duration,
                    }
                )
            except Exception as err:
                ok = False
                result = getattr(err, "result", None)
                results.append(
                    {
                        "cmd": cmd,
                        "exit_code": getattr(result, "exit_code", 1) if result else 1,
                        "stdout": getattr(result, "stdout", "") if result else "",
                        "stderr": getattr(result, "stderr", "") if result else str(err),
                        "duration": getattr(result, "duration", "") if result else "",
                    }
                )
        out = _to_json(results)
        if not ok:
            return ToolResult(id=call.id, ok=False, error="verification failed", parts=[MessagePart(type="text", text=out)])
        return ToolResult(id=call.id, ok=True, parts=[MessagePart(type="text", text=out)])
