from __future__ import annotations

import secrets
from datetime import datetime, timezone

_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"


def _base32_encode(data: bytes) -> str:
    bits = 0
    value = 0
    output = []
    for byte in data:
        value = (value << 8) | byte
        bits += 8
        while bits >= 5:
            index = (value >> (bits - 5)) & 31
            output.append(_ALPHABET[index])
            bits -= 5
    if bits > 0:
        output.append(_ALPHABET[(value << (5 - bits)) & 31])
    return "".join(output)


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dt%H%M%Sz")


def _new_id(prefix: str) -> str:
    raw = secrets.token_bytes(10)
    enc = _base32_encode(raw)
    return f"{prefix}{_timestamp()}_{enc}"


def new_run_id() -> str:
    return _new_id("run_")


def new_step_id() -> str:
    return _new_id("step_")


def new_session_id() -> str:
    return _new_id("sess_")


def new_message_id() -> str:
    return _new_id("msg_")


def new_turn_id() -> str:
    return _new_id("turn_")


def new_tool_call_id() -> str:
    return _new_id("call_")


def new_attachment_id() -> str:
    return _new_id("att_")
