from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional


RunStatus = Literal["queued", "running", "waiting_approval", "succeeded", "failed", "canceled"]
StepStatus = Literal["pending", "running", "waiting_approval", "succeeded", "failed", "skipped"]


@dataclass
class Step:
    id: str
    title: str
    type: str
    needs_approval: bool
    command: Optional[str] = None
    status: StepStatus = "pending"
    started_at: Optional[str] = None
    completed_at: Optional[str] = None


@dataclass
class Run:
    id: str
    created_at: str
    updated_at: str
    status: RunStatus
    workspace_path: str
    spec_path: str
    model_canonical: Optional[str] = None
    steps: Optional[List[Step]] = None
    error: Optional[str] = None


@dataclass
class Event:
    ts: str
    run_id: str
    type: str
    message: Optional[str] = None
    data: Optional[Dict[str, object]] = None
