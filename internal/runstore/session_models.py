from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Literal, Optional


SessionStatus = Literal["active", "waiting_approval", "completed", "failed", "canceled"]
SessionMode = Literal["chat", "spec"]
TurnStatus = Literal["pending", "running", "waiting_approval", "succeeded", "failed"]


@dataclass
class MessagePart:
    type: str
    text: Optional[str] = None
    ref: Optional[str] = None
    mime_type: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_name: Optional[str] = None
    tool_input: Optional[object] = None


@dataclass
class Message:
    id: str
    role: str
    parts: List[MessagePart]
    created_at: str
    tool_call_id: Optional[str] = None


@dataclass
class Turn:
    id: str
    status: TurnStatus
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    error: Optional[str] = None


@dataclass
class SessionCost:
    input_cost_usd: Optional[float] = None
    output_cost_usd: Optional[float] = None
    total_cost_usd: Optional[float] = None


@dataclass
class Session:
    id: str
    created_at: str
    updated_at: str
    status: SessionStatus
    mode: Optional[SessionMode]
    workspace_path: str
    system_prompt: Optional[str] = None
    spec_path: Optional[str] = None
    last_turn_id: Optional[str] = None
    messages: Optional[List[Message]] = None
    turns: Optional[List[Turn]] = None
    cost: Optional[SessionCost] = None
    error: Optional[str] = None


@dataclass
class SessionEvent:
    ts: str
    session_id: str
    turn_id: Optional[str] = None
    type: str = ""
    message: Optional[str] = None
    data: Optional[Dict[str, object]] = None


@dataclass
class ApprovalDecision:
    action: str
    reason: Optional[str] = None
