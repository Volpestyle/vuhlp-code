from __future__ import annotations

from typing import List, Optional, TypedDict


class CreateRunRequest(TypedDict):
    workspace_path: str
    spec_path: str


class CreateRunResponse(TypedDict):
    run_id: str


class ApproveRequest(TypedDict):
    step_id: str


class CreateSessionRequest(TypedDict, total=False):
    workspace_path: str
    system_prompt: Optional[str]
    auto_run: Optional[bool]
    mode: Optional[str]
    spec_path: Optional[str]


class CreateSessionResponse(TypedDict, total=False):
    session_id: str
    spec_path: Optional[str]


class UpdateSessionModeRequest(TypedDict, total=False):
    mode: str
    spec_path: Optional[str]


class UpdateSessionModeResponse(TypedDict, total=False):
    session_id: str
    mode: str
    spec_path: Optional[str]


class MessagePart(TypedDict, total=False):
    type: str
    text: Optional[str]
    ref: Optional[str]
    mime_type: Optional[str]


class AddMessageRequest(TypedDict, total=False):
    role: str
    parts: List[MessagePart]
    auto_run: Optional[bool]


class AddMessageResponse(TypedDict):
    message_id: str
    turn_id: str


class SessionApproveRequest(TypedDict, total=False):
    turn_id: Optional[str]
    tool_call_id: str
    action: Optional[str]
    reason: Optional[str]


class AttachmentUploadRequest(TypedDict, total=False):
    name: Optional[str]
    mime_type: Optional[str]
    content_base64: str


class AttachmentUploadResponse(TypedDict):
    ref: str
    mime_type: str


class GenerateSpecRequest(TypedDict, total=False):
    workspace_path: str
    spec_name: str
    prompt: str
    overwrite: Optional[bool]


class GenerateSpecResponse(TypedDict):
    spec_path: str
    content: str
