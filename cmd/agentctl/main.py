#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

import httpx

from internal.util.lookpath import look_path


def main() -> None:
    parser = argparse.ArgumentParser(prog="agentctl", add_help=False)
    parser.add_argument("-h", "--help", action="store_true")
    subparsers = parser.add_subparsers(dest="command")

    parser_init = subparsers.add_parser("init")
    parser_init.add_argument("--force", action="store_true")

    parser_spec = subparsers.add_parser("spec")
    spec_sub = parser_spec.add_subparsers(dest="spec_command")
    spec_new = spec_sub.add_parser("new")
    spec_new.add_argument("name")
    spec_prompt = spec_sub.add_parser("prompt")
    spec_prompt.add_argument("name")
    spec_prompt.add_argument("--prompt", default="")
    spec_prompt.add_argument("--prompt-file", dest="prompt_file", default="")
    spec_prompt.add_argument("--workspace", default=".")
    spec_prompt.add_argument("--url", default="")
    spec_prompt.add_argument("--overwrite", action="store_true")
    spec_prompt.add_argument("--print", dest="print_spec", action="store_true")

    parser_run = subparsers.add_parser("run")
    parser_run.add_argument("--workspace", default=".")
    parser_run.add_argument("--spec", required=True)
    parser_run.add_argument("--url", default="")

    parser_attach = subparsers.add_parser("attach")
    parser_attach.add_argument("run_id")
    parser_attach.add_argument("--url", default="")

    parser_approve = subparsers.add_parser("approve")
    parser_approve.add_argument("run_id")
    parser_approve.add_argument("--step", required=True)
    parser_approve.add_argument("--url", default="")

    parser_session = subparsers.add_parser("session")
    session_sub = parser_session.add_subparsers(dest="session_command")
    session_new = session_sub.add_parser("new")
    session_new.add_argument("--workspace", default=".")
    session_new.add_argument("--system", default="")
    session_new.add_argument("--mode", default="chat")
    session_new.add_argument("--spec", default="")
    session_new.add_argument("--url", default="")

    session_message = session_sub.add_parser("message")
    session_message.add_argument("session_id")
    session_message.add_argument("--text", default="")
    session_message.add_argument("--ref", default="")
    session_message.add_argument("--type", dest="ref_type", default="")
    session_message.add_argument("--mime", default="")
    session_message.add_argument("--role", default="user")
    session_message.add_argument("--auto-run", dest="auto_run", action="store_true")
    session_message.add_argument("--no-auto-run", dest="auto_run", action="store_false")
    session_message.set_defaults(auto_run=True)
    session_message.add_argument("--url", default="")

    session_attach = session_sub.add_parser("attach")
    session_attach.add_argument("session_id")
    session_attach.add_argument("--file", required=True)
    session_attach.add_argument("--name", default="")
    session_attach.add_argument("--mime", default="")
    session_attach.add_argument("--url", default="")

    session_approve = session_sub.add_parser("approve")
    session_approve.add_argument("session_id")
    session_approve.add_argument("--call", required=True)
    session_approve.add_argument("--turn", default="")
    session_approve.add_argument("--reason", default="")
    session_approve.add_argument("--deny", action="store_true")
    session_approve.add_argument("--url", default="")

    parser_list = subparsers.add_parser("list")
    parser_list.add_argument("--url", default="")

    parser_export = subparsers.add_parser("export")
    parser_export.add_argument("run_id")
    parser_export.add_argument("--out", required=True)
    parser_export.add_argument("--url", default="")

    parser_doctor = subparsers.add_parser("doctor")

    args, _ = parser.parse_known_args()

    if args.help or not args.command:
        usage()
        sys.exit(2 if not args.command else 0)

    if args.command == "init":
        cmd_init(args.force)
        return
    if args.command == "spec":
        if args.spec_command == "new":
            cmd_spec_new(args.name)
            return
        if args.spec_command == "prompt":
            cmd_spec_prompt(args)
            return
        print("spec requires a subcommand (new|prompt)")
        sys.exit(2)
    if args.command == "run":
        cmd_run(args)
        return
    if args.command == "attach":
        cmd_attach(args)
        return
    if args.command == "approve":
        cmd_approve(args)
        return
    if args.command == "session":
        cmd_session(args)
        return
    if args.command == "list":
        cmd_list(args)
        return
    if args.command == "export":
        cmd_export(args)
        return
    if args.command == "doctor":
        cmd_doctor()
        return
    print(f"unknown command: {args.command}")
    usage()
    sys.exit(2)


def usage() -> None:
    print(
        """agentctl - CLI client for agentd

Usage:
  agentctl init [--force]
  agentctl spec new <name>
  agentctl spec prompt <name> --prompt <text> [--workspace <path>] [--url <base>] [--overwrite] [--print]
  agentctl run --workspace <path> --spec <path> [--url <base>]
  agentctl attach <run_id> [--url <base>]
  agentctl approve <run_id> --step <step_id> [--url <base>]
  agentctl session new --workspace <path> [--system <text>] [--mode <chat|spec>] [--spec <path>] [--url <base>]
  agentctl session message <session_id> --text <msg> [--auto-run] [--url <base>]
  agentctl session attach <session_id> --file <path> [--url <base>]
  agentctl session approve <session_id> --call <tool_call_id> [--deny] [--reason <text>] [--url <base>]
  agentctl list [--url <base>]
  agentctl export <run_id> --out <file.zip> [--url <base>]
  agentctl doctor

Environment:
  HARNESS_URL         Base URL for agentd (default http://127.0.0.1:8787)
  HARNESS_AUTH_TOKEN  Bearer token (optional, must match agentd)
"""
    )


def base_url(flag_url: str) -> str:
    if flag_url.strip():
        return flag_url.strip().rstrip("/")
    env = os.environ.get("HARNESS_URL", "").strip()
    if env:
        return env.rstrip("/")
    return "http://127.0.0.1:8787"


def auth_token() -> str:
    return os.environ.get("HARNESS_AUTH_TOKEN", "").strip()


def do_json(method: str, url: str, body: Any | None = None) -> Any:
    headers: Dict[str, str] = {"Content-Type": "application/json"}
    tok = auth_token()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    with httpx.Client() as client:
        resp = client.request(method, url, headers=headers, json=body)
    if resp.status_code >= 400:
        raise RuntimeError(f"http {resp.status_code}: {resp.text.strip()}")
    if resp.status_code == 204:
        return None
    return resp.json() if resp.text else None


def cmd_init(force: bool) -> None:
    cwd = Path.cwd()

    def write(rel: str, content: str) -> None:
        target = cwd / rel
        if not force and target.exists():
            print(f"[init] exists, skipping: {rel}")
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    agents = """# AGENTS.md

Project-specific instructions for coding agents.

## Build
- make test

## Safety
- Destructive commands require approval.
"""
    write("AGENTS.md", agents)
    write("docs/diagrams/README.md", "Diagram sources (.mmd/.dac) and exported PNGs live here.\n")
    write("docs/diagrams/agent-harness.mmd", "flowchart LR\n  A[spec]-->B[agent]\n")
    write("specs/README.md", "# Specs\n\nSpecs live in specs/<name>/spec.md\n")
    write("specs/example/spec.md", "# Example spec\n\nDescribe the goal + acceptance tests.\n")

    print("[init] done")


def cmd_spec_new(name: str) -> None:
    cwd = Path.cwd()
    dir_path = cwd / "specs" / name / "diagrams"
    dir_path.mkdir(parents=True, exist_ok=True)
    spec_path = dir_path.parent / "spec.md"
    if spec_path.exists():
        print(f"[spec] exists: {spec_path}")
        return
    spec = (
        f"---\nname: {name}\nstatus: draft\n---\n\n"
        "# Goal\n\nDescribe what you want built.\n\n"
        "# Constraints\n\n- Any AWS/IaC changes require approval.\n\n"
        "# Acceptance tests\n\n- make test\n"
    )
    spec_path.write_text(spec, encoding="utf-8")
    mmd = "flowchart LR\n  A[idea]-->B[done]\n"
    (dir_path / "diagram.mmd").write_text(mmd, encoding="utf-8")
    print(f"[spec] created: {spec_path}")


def cmd_spec_prompt(args) -> None:
    prompt_text = (args.prompt or "").strip()
    if not prompt_text and args.prompt_file:
        prompt_text = Path(args.prompt_file).read_text(encoding="utf-8").strip()
    if not prompt_text:
        die("prompt text is required")
    workspace = str(Path(args.workspace).resolve())
    resp = do_json(
        "POST",
        f"{base_url(args.url)}/v1/specs/generate",
        {
            "workspace_path": workspace,
            "spec_name": args.name,
            "prompt": prompt_text,
            "overwrite": bool(args.overwrite),
        },
    )
    print(resp["spec_path"])
    if args.print_spec:
        print(resp["content"])


def cmd_run(args) -> None:
    workspace = str(Path(args.workspace).resolve())
    spec_path = str(Path(args.spec).resolve())
    resp = do_json(
        "POST",
        f"{base_url(args.url)}/v1/runs",
        {"workspace_path": workspace, "spec_path": spec_path},
    )
    print(resp["run_id"])


def cmd_attach(args) -> None:
    url = f"{base_url(args.url)}/v1/runs/{args.run_id}/events"
    headers: Dict[str, str] = {}
    tok = auth_token()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    with httpx.stream("GET", url, headers=headers) as resp:
        if resp.status_code >= 400:
            die(f"http {resp.status_code}: {resp.text.strip()}")
        for line in resp.iter_lines():
            if not line:
                continue
            if line.startswith("data: "):
                payload = line[6:]
                try:
                    ev = json.loads(payload)
                    print_event(ev)
                except Exception:
                    print(payload)


def cmd_approve(args) -> None:
    do_json(
        "POST",
        f"{base_url(args.url)}/v1/runs/{args.run_id}/approve",
        {"step_id": args.step},
    )
    print("ok")


def cmd_session(args) -> None:
    if args.session_command == "new":
        cmd_session_new(args)
        return
    if args.session_command == "message":
        cmd_session_message(args)
        return
    if args.session_command == "attach":
        cmd_session_attach(args)
        return
    if args.session_command == "approve":
        cmd_session_approve(args)
        return
    die("session requires a subcommand (new|message|attach|approve)")


def cmd_session_new(args) -> None:
    workspace = str(Path(args.workspace).resolve())
    resp = do_json(
        "POST",
        f"{base_url(args.url)}/v1/sessions",
        {
            "workspace_path": workspace,
            "system_prompt": args.system or "",
            "mode": args.mode or "chat",
            "spec_path": args.spec or "",
        },
    )
    print(resp["session_id"])


def cmd_session_message(args) -> None:
    parts = []
    if args.text.strip():
        parts.append({"type": "text", "text": args.text})
    if args.ref.strip():
        ref_type = (args.ref_type or "").strip()
        mime_type = (args.mime or "").strip()
        if not ref_type:
            ref_type = "image" if mime_type.startswith("image/") else "file"
        parts.append({"type": ref_type, "ref": args.ref, "mime_type": mime_type})
    if not parts:
        die("message requires --text or --ref")
    resp = do_json(
        "POST",
        f"{base_url(args.url)}/v1/sessions/{args.session_id}/messages",
        {"role": args.role or "user", "parts": parts, "auto_run": args.auto_run},
    )
    print(f"{resp['message_id']} {resp['turn_id']}")


def cmd_session_attach(args) -> None:
    data = Path(args.file).read_bytes()
    enc = base64.b64encode(data).decode("ascii")
    filename = args.name or Path(args.file).name
    import mimetypes

    detected, _ = mimetypes.guess_type(filename)
    mime_type = args.mime or (detected or "application/octet-stream")
    resp = do_json(
        "POST",
        f"{base_url(args.url)}/v1/sessions/{args.session_id}/attachments",
        {"name": filename, "mime_type": mime_type, "content_base64": enc},
    )
    print(f"{resp['ref']} {resp['mime_type']}")


def cmd_session_approve(args) -> None:
    action = "deny" if args.deny else "approve"
    do_json(
        "POST",
        f"{base_url(args.url)}/v1/sessions/{args.session_id}/approve",
        {
            "turn_id": args.turn or "",
            "tool_call_id": args.call,
            "action": action,
            "reason": args.reason or "",
        },
    )
    print("ok")


def cmd_list(args) -> None:
    runs = do_json("GET", f"{base_url(args.url)}/v1/runs")
    for run in runs or []:
        print(f"{run['id']}  {str(run['status']).ljust(18)}  {run['spec_path']}")


def cmd_export(args) -> None:
    url = f"{base_url(args.url)}/v1/runs/{args.run_id}/export"
    headers: Dict[str, str] = {}
    tok = auth_token()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    with httpx.stream("GET", url, headers=headers) as resp:
        if resp.status_code >= 400:
            die(f"http {resp.status_code}: {resp.text.strip()}")
        data = resp.read()
    Path(args.out).write_bytes(data)
    print(f"wrote {args.out}")


def cmd_doctor() -> None:
    print("doctor:")
    check("git")
    check("rg (ripgrep)")
    check("ctags (universal-ctags)")
    check("mmdc (mermaid-cli)")
    check("awsdac (diagram-as-code)")
    print("notes:")
    print("- For Mermaid diagrams, you can also use `npx -y @mermaid-js/mermaid-cli`.")
    print("- For remote cockpit, prefer an authenticated tunnel (Tailscale/Cloudflare).")


def check(cmd: str) -> None:
    name = cmd.split(" ")[0]
    try:
        resolved = look_path(name)
        print(f"  - {cmd.ljust(18)} OK ({resolved})")
    except Exception:
        print(f"  - {cmd.ljust(18)} MISSING")


def print_event(ev: Dict[str, Any]) -> None:
    ts = ev.get("ts", "")
    typ = ev.get("type", "")
    msg = ev.get("message", "-") or "-"
    print(f"{ts}  {str(typ).ljust(22)}  {msg}")


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
