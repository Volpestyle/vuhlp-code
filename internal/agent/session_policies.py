from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

from .tools import ToolKind


@dataclass
class VerifyPolicy:
    auto_verify: bool = True
    commands: List[str] = field(default_factory=lambda: ["make test"])
    require_clean: bool = False


@dataclass
class ApprovalPolicy:
    require_for_kinds: List[ToolKind] = field(default_factory=lambda: ["exec", "write"])
    require_for_tools: List[str] = field(default_factory=list)


@dataclass
class PatchReviewPolicy:
    mode: str = ""


def default_verify_policy() -> VerifyPolicy:
    return VerifyPolicy()


def default_approval_policy() -> ApprovalPolicy:
    return ApprovalPolicy()
