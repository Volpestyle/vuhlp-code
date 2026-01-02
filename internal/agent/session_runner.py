from __future__ import annotations

import base64
import json
import threading
from pathlib import Path
from typing import Dict, List, Optional, TYPE_CHECKING

from internal.config import ModelPolicy
from internal.runstore import Store
from internal.runstore.session_models import Message as SessionMessage
from internal.runstore.session_models import MessagePart, Session, SessionCost
from internal.util.cancel import CancelToken
from internal.util.id import new_message_id, new_tool_call_id
from internal.util.spec import default_spec_path, ensure_spec_file
from .context import gather_context
from .session_policies import default_approval_policy, default_verify_policy
from .spec_tools import SpecReadTool, SpecValidateTool, SpecWriteTool
from .tools import AikitAdapter, Tool, ToolCall, ToolDefinition, ToolRegistry, ToolResult, default_tool_registry

if TYPE_CHECKING:
    from ai_kit import Kit, Message, ModelRecord, ToolDefinition as AikitToolDefinition
    from ai_kit.router import ModelRouter


class SessionRunner:
    def __init__(self, store: Store, kit: "Kit", policy: ModelPolicy, router: "ModelRouter") -> None:
        self._store = store
        self._kit = kit
        self._policy = policy
        self._router = router
        self._running: set[str] = set()
        self._lock = threading.Lock()
        self.tools_factory = lambda workspace, verify: default_tool_registry(workspace, verify.commands)
        self.verify_policy = default_verify_policy()
        self.approval_policy = default_approval_policy()
        self.adapter = AikitAdapter()

    def set_policy(self, policy: ModelPolicy) -> None:
        self._policy = policy

    def start_turn(self, session_id: str, turn_id: str) -> None:
        with self._lock:
            if session_id in self._running:
                raise RuntimeError(f"session already running: {session_id}")
            self._running.add(session_id)
        token = CancelToken()
        self._store.set_session_cancel(session_id, token)
        thread = threading.Thread(target=self._execute_turn, args=(session_id, turn_id, token), daemon=True)
        thread.start()

    def _execute_turn(self, session_id: str, turn_id: str, token: CancelToken) -> None:
        try:
            session = self._store.get_session(session_id)
            turn_idx = next((idx for idx, turn in enumerate(session.turns or []) if turn.id == turn_id), -1)
            if turn_idx == -1:
                raise RuntimeError(f"turn not found: {turn_id}")

            now = _now()
            session.status = "active"
            session.last_turn_id = turn_id
            session.turns = session.turns or []
            session.turns[turn_idx].status = "running"
            session.turns[turn_idx].started_at = now
            session.turns[turn_idx].error = ""
            self._store.update_session(session)
            self._store.append_session_event(session_id, _session_event(session_id, turn_id, "turn_started"))

            bundle = gather_context(session.workspace_path, token)
            model = self._resolve_model()
            self._store.append_session_event(
                session_id,
                _session_event(session_id, turn_id, "model_resolved", data={"model": model.id}),
            )

            max_turns = 8
            workspace_dirty = False
            tool_call_counts: Dict[str, int] = {}

            tool_registry = self.tools_factory(session.workspace_path, self.verify_policy)

            if session.mode == "spec":
                if not (session.spec_path or "").strip():
                    session.spec_path = default_spec_path(session.workspace_path, f"session-{session.id}")
                    self._store.update_session(session)
                    self._store.append_session_event(
                        session_id,
                        _session_event(
                            session_id,
                            turn_id,
                            "spec_path_set",
                            data={"spec_path": session.spec_path},
                        ),
                    )
                created = ensure_spec_file(session.spec_path or "")
                if created:
                    self._store.append_session_event(
                        session_id,
                        _session_event(
                            session_id,
                            turn_id,
                            "spec_created",
                            data={"spec_path": session.spec_path},
                        ),
                    )
                tool_registry.add(SpecReadTool(session.spec_path or ""))
                tool_registry.add(SpecWriteTool(session.spec_path or ""))
                tool_registry.add(SpecValidateTool(session.spec_path or ""))

            for _ in range(max_turns):
                if token.is_cancelled():
                    self._cancel_turn(session_id, turn_id, token.reason or RuntimeError("canceled"))
                    return
                aikit_messages = self._build_aikit_messages(session, bundle, model)
                tools = self.adapter.to_aikit_tools(tool_registry.definitions())
                assistant_text, tool_calls, cost = self._run_model(session_id, turn_id, model, aikit_messages, tools)
                self._record_session_cost(session, cost)

                calls_to_run: List[Dict[str, object]] = []
                for call in tool_calls:
                    tool = tool_registry.get(call.name)
                    if not tool:
                        raise RuntimeError(f"unknown tool: {call.name}")
                    call_key = _tool_call_key(call)
                    count = tool_call_counts.get(call_key, 0)
                    if count > 0:
                        self._append_skipped_tool(session_id, turn_id, call, "duplicate tool call: no new info")
                        continue
                    tool_call_counts[call_key] = count + 1
                    calls_to_run.append({"call": call, "tool": tool})

                assistant_parts: List[MessagePart] = []
                if assistant_text.strip():
                    assistant_parts.append(MessagePart(type="text", text=assistant_text))
                for entry in calls_to_run:
                    call = entry["call"]
                    assistant_parts.append(
                        MessagePart(
                            type="tool_use",
                            tool_call_id=call.id,
                            tool_name=call.name,
                            tool_input=_parse_tool_input(call.input),
                        )
                    )
                if assistant_parts:
                    msg = SessionMessage(
                        id=new_message_id(),
                        role="assistant",
                        parts=assistant_parts,
                        created_at=_now(),
                    )
                    self._store.append_message(session_id, msg)
                    self._store.append_session_event(
                        session_id,
                        _session_event(
                            session_id,
                            turn_id,
                            "message_added",
                            data={"message_id": msg.id, "role": msg.role},
                        ),
                    )
                    session.messages = session.messages or []
                    session.messages.append(msg)

                if not tool_calls:
                    if self.verify_policy.auto_verify and workspace_dirty:
                        verify_msg, ok = self._invoke_verify(session_id, turn_id, tool_registry, token)
                        session.messages = session.messages or []
                        session.messages.append(verify_msg)
                        if not ok:
                            continue
                    self._complete_turn(session_id, turn_id)
                    return

                new_tool_calls = 0
                for entry in calls_to_run:
                    call: ToolCall = entry["call"]
                    tool: Tool = entry["tool"]
                    new_tool_calls += 1

                    if self._requires_approval(tool.definition()):
                        session.status = "waiting_approval"
                        for turn in session.turns or []:
                            if turn.id == turn_id:
                                turn.status = "waiting_approval"
                        self._store.update_session(session)
                        self._store.require_session_approval(session_id, call.id)
                        self._store.append_session_event(
                            session_id,
                            _session_event(
                                session_id,
                                turn_id,
                                "approval_requested",
                                data={"tool": call.name, "tool_call_id": call.id},
                            ),
                        )
                        decision = self._store.wait_for_session_approval(session_id, call.id, token)
                        if decision.action == "deny":
                            self._store.append_session_event(
                                session_id,
                                _session_event(
                                    session_id,
                                    turn_id,
                                    "approval_denied",
                                    data={"tool": call.name, "tool_call_id": call.id, "reason": decision.reason},
                                ),
                            )
                            raise RuntimeError("approval denied")
                        session.status = "active"
                        for turn in session.turns or []:
                            if turn.id == turn_id:
                                turn.status = "running"
                        self._store.update_session(session)
                        self._store.append_session_event(
                            session_id,
                            _session_event(
                                session_id,
                                turn_id,
                                "approval_granted",
                                data={"tool": call.name, "tool_call_id": call.id, "reason": decision.reason},
                            ),
                        )

                    self._store.append_session_event(
                        session_id,
                        _session_event(
                            session_id,
                            turn_id,
                            "tool_call_started",
                            data={"tool": call.name, "tool_call_id": call.id},
                        ),
                    )
                    try:
                        result = tool.invoke(call, token)
                    except Exception as err:
                        result = ToolResult(id=call.id, ok=False, error=str(err), parts=[])
                    self._store.append_session_event(
                        session_id,
                        _session_event(
                            session_id,
                            turn_id,
                            "tool_call_completed",
                            data={
                                "tool": call.name,
                                "tool_call_id": call.id,
                                "ok": result.ok,
                                "error": result.error,
                            },
                        ),
                    )

                    tool_msg = SessionMessage(
                        id=new_message_id(),
                        role="tool",
                        tool_call_id=call.id,
                        parts=result.parts or [],
                        created_at=_now(),
                    )
                    self._store.append_message(session_id, tool_msg)
                    self._store.append_session_event(
                        session_id,
                        _session_event(
                            session_id,
                            turn_id,
                            "message_added",
                            data={"message_id": tool_msg.id, "role": tool_msg.role},
                        ),
                    )
                    session.messages = session.messages or []
                    session.messages.append(tool_msg)

                    definition = tool.definition()
                    if definition.kind in ("write", "exec") and not (
                        session.mode == "spec" and call.name == "write_spec"
                    ):
                        workspace_dirty = True

                    if session.mode == "spec" and call.name == "write_spec":
                        validate_msg, ok = self._invoke_spec_validate(session_id, turn_id, tool_registry, token)
                        session.messages = session.messages or []
                        session.messages.append(validate_msg)
                        if not ok:
                            continue

                    if not result.ok:
                        break

                if new_tool_calls == 0:
                    if self.verify_policy.auto_verify and workspace_dirty:
                        verify_msg, ok = self._invoke_verify(session_id, turn_id, tool_registry, token)
                        session.messages = session.messages or []
                        session.messages.append(verify_msg)
                        if not ok:
                            continue
                    self._complete_turn(session_id, turn_id)
                    return

            raise RuntimeError("max turn iterations reached")
        except Exception as err:
            self._fail_turn(session_id, turn_id, err)
            raise
        finally:
            with self._lock:
                self._running.discard(session_id)

    def _resolve_model(self) -> "ModelRecord":
        from ai_kit import ModelConstraints, ModelResolutionRequest

        records = self._kit.list_model_records()
        resolved = self._router.resolve(
            records,
            ModelResolutionRequest(
                constraints=ModelConstraints(
                    requireTools=self._policy.require_tools,
                    requireVision=self._policy.require_vision,
                    maxCostUsd=self._policy.max_cost_usd,
                ),
                preferredModels=self._policy.preferred_models,
            ),
        )
        return resolved.primary

    def _build_aikit_messages(self, session: Session, bundle, model) -> List["Message"]:
        messages: List[SessionMessage] = []
        if (session.system_prompt or "").strip():
            messages.append(
                SessionMessage(
                    id=new_message_id(),
                    role="system",
                    parts=[MessagePart(type="text", text=session.system_prompt or "")],
                    created_at=_now(),
                )
            )
        if session.mode == "spec":
            messages.append(
                SessionMessage(
                    id=new_message_id(),
                    role="system",
                    parts=[MessagePart(type="text", text=_spec_mode_prompt(session.spec_path or ""))],
                    created_at=_now(),
                )
            )
        context_text = _build_context_text(bundle)
        if context_text:
            messages.append(
                SessionMessage(
                    id=new_message_id(),
                    role="system",
                    parts=[MessagePart(type="text", text=context_text)],
                    created_at=_now(),
                )
            )
        if session.mode == "spec" and session.spec_path:
            try:
                content = Path(session.spec_path).read_text(encoding="utf-8")
                if content.strip():
                    messages.append(
                        SessionMessage(
                            id=new_message_id(),
                            role="system",
                            parts=[MessagePart(type="text", text=f"CURRENT SPEC ({session.spec_path}):\n{content}")],
                            created_at=_now(),
                        )
                    )
            except Exception:
                pass
        base = session.messages or []
        # ai-kit Python does not emit tool-use message parts, so inline tool outputs.
        prepared = self._prepare_session_messages(base, False)
        all_messages = messages + prepared
        return self._to_aikit_messages(session.id, all_messages)

    def _prepare_session_messages(self, messages: List[SessionMessage], supports_tools: bool) -> List[SessionMessage]:
        out: List[SessionMessage] = []
        seen_tool_uses: set[str] = set()
        for msg in messages:
            normalized = msg
            if normalized.parts:
                for part in normalized.parts:
                    if part.type == "tool_use" and part.tool_call_id:
                        seen_tool_uses.add(part.tool_call_id)
            if not supports_tools and normalized.parts:
                filtered = [part for part in normalized.parts if part.type != "tool_use"]
                if not filtered:
                    continue
                normalized = SessionMessage(
                    id=normalized.id,
                    role=normalized.role,
                    parts=filtered,
                    created_at=normalized.created_at,
                    tool_call_id=normalized.tool_call_id,
                )
            if normalized.role != "tool":
                out.append(normalized)
                continue
            if supports_tools and normalized.tool_call_id and normalized.tool_call_id in seen_tool_uses:
                out.append(normalized)
                continue
            text = _tool_message_text(normalized.parts or [])
            if not text.strip():
                text = "(no output)"
            label = f"TOOL OUTPUT ({normalized.tool_call_id})" if normalized.tool_call_id else "TOOL OUTPUT"
            out.append(
                SessionMessage(
                    id=normalized.id,
                    role="user",
                    parts=[MessagePart(type="text", text=f"{label}:\n{text}")],
                    created_at=normalized.created_at,
                )
            )
        return [
            SessionMessage(
                id=msg.id,
                role=msg.role,
                parts=_trim_text_parts(msg.parts or []),
                created_at=msg.created_at,
                tool_call_id=msg.tool_call_id,
            )
            if msg.role == "assistant"
            else msg
            for msg in out
        ]

    def _to_aikit_messages(self, session_id: str, messages: List[SessionMessage]) -> List["Message"]:
        from ai_kit import Message, ContentPart

        out: List[Message] = []
        for msg in messages:
            parts: List[ContentPart] = []
            for part in msg.parts or []:
                if part.type == "text":
                    parts.append(ContentPart(type="text", text=part.text or ""))
                elif part.type == "tool_use":
                    continue
                elif part.type == "image":
                    img = self._load_image_attachment(session_id, part.ref or "", part.mime_type or "")
                    if img:
                        parts.append(ContentPart(type="image", image=img))
                    else:
                        parts.append(ContentPart(type="text", text=f"[image: {part.ref}]") )
                else:
                    if part.ref:
                        parts.append(ContentPart(type="text", text=f"[{part.type}: {part.ref}]"))
                    elif part.text:
                        parts.append(ContentPart(type="text", text=part.text))
            out.append(Message(role=msg.role, content=parts, toolCallId=msg.tool_call_id))
        return out

    def _load_image_attachment(self, session_id: str, ref: str, mime_type: str) -> Optional[Dict[str, str]]:
        if not ref:
            return None
        base = Path(self._store.data_directory()) / "sessions" / session_id
        target = (base / ref.lstrip("/")).resolve()
        if not str(target).startswith(str(base.resolve())):
            return None
        try:
            data = target.read_bytes()
        except Exception:
            return None
        return {
            "base64": base64.b64encode(data).decode("ascii"),
            "mediaType": mime_type or "image/png",
        }

    def _run_model(
        self,
        session_id: str,
        turn_id: str,
        model: "ModelRecord",
        messages: List["Message"],
        tools: List["AikitToolDefinition"],
    ) -> tuple[str, List[ToolCall], Optional[object]]:
        from ai_kit import GenerateInput

        output = self._kit.generate(
            GenerateInput(
                provider=model.provider,
                model=model.providerModelId,
                messages=messages,
                tools=tools,
            )
        )
        cost = output.cost
        if cost is None and output.usage:
            try:
                from ai_kit.pricing import estimate_cost
            except Exception:
                cost = None
            else:
                model_id = model.providerModelId or model.id
                cost = estimate_cost(model.provider, model_id, output.usage)
        assistant_text = output.text or ""
        if assistant_text:
            self._store.append_session_event(
                session_id,
                _session_event(session_id, turn_id, "model_output_delta", data={"delta": assistant_text}),
            )
        self._store.append_session_event(
            session_id,
            _session_event(
                session_id,
                turn_id,
                "model_output_completed",
                data={"finish_reason": output.finishReason},
            ),
        )
        tool_calls: List[ToolCall] = []
        for call in output.toolCalls or []:
            tool_call = self.adapter.from_aikit_call(call)
            if not tool_call.id:
                tool_call.id = new_tool_call_id()
            tool_calls.append(tool_call)
        return assistant_text, tool_calls, cost

    def _record_session_cost(self, session: Session, cost: Optional[object]) -> None:
        if not cost:
            return
        if (
            getattr(cost, "input_cost_usd", None) is None
            and getattr(cost, "output_cost_usd", None) is None
            and getattr(cost, "total_cost_usd", None) is None
        ):
            return
        if session.cost is None:
            session.cost = SessionCost(input_cost_usd=0.0, output_cost_usd=0.0, total_cost_usd=0.0)
        input_cost = getattr(cost, "input_cost_usd", None) or 0.0
        output_cost = getattr(cost, "output_cost_usd", None) or 0.0
        total_cost = getattr(cost, "total_cost_usd", None)
        if total_cost is None:
            total_cost = input_cost + output_cost
        session.cost.input_cost_usd = round((session.cost.input_cost_usd or 0.0) + input_cost, 6)
        session.cost.output_cost_usd = round((session.cost.output_cost_usd or 0.0) + output_cost, 6)
        session.cost.total_cost_usd = round((session.cost.total_cost_usd or 0.0) + total_cost, 6)
        self._store.update_session(session)

    def _invoke_verify(
        self,
        session_id: str,
        turn_id: str,
        tool_registry: ToolRegistry,
        token: CancelToken,
    ) -> tuple[SessionMessage, bool]:
        verify_call = ToolCall(id=new_tool_call_id(), name="verify", input="{}")
        tool = tool_registry.get("verify")
        if not tool:
            raise RuntimeError("verify tool not configured")
        if self._requires_approval(tool.definition()):
            self._store.require_session_approval(session_id, verify_call.id)
            self._store.append_session_event(
                session_id,
                _session_event(
                    session_id,
                    turn_id,
                    "approval_requested",
                    data={"tool": "verify", "tool_call_id": verify_call.id},
                ),
            )
            decision = self._store.wait_for_session_approval(session_id, verify_call.id, token)
            if decision.action == "deny":
                raise RuntimeError("verification denied")
        self._store.append_session_event(
            session_id,
            _session_event(
                session_id,
                turn_id,
                "tool_call_started",
                data={"tool": "verify", "tool_call_id": verify_call.id},
            ),
        )
        try:
            result = tool.invoke(verify_call, token)
        except Exception as err:
            result = ToolResult(id=verify_call.id, ok=False, error=str(err), parts=[])
        self._store.append_session_event(
            session_id,
            _session_event(
                session_id,
                turn_id,
                "tool_call_completed",
                data={"tool": "verify", "tool_call_id": verify_call.id, "ok": result.ok, "error": result.error},
            ),
        )
        msg = SessionMessage(
            id=new_message_id(),
            role="tool",
            tool_call_id=verify_call.id,
            parts=result.parts or [],
            created_at=_now(),
        )
        self._store.append_message(session_id, msg)
        self._store.append_session_event(
            session_id,
            _session_event(session_id, turn_id, "message_added", data={"message_id": msg.id, "role": msg.role}),
        )
        return msg, result.ok

    def _invoke_spec_validate(
        self,
        session_id: str,
        turn_id: str,
        tool_registry: ToolRegistry,
        token: CancelToken,
    ) -> tuple[SessionMessage, bool]:
        call = ToolCall(id=new_tool_call_id(), name="validate_spec", input="{}")
        tool = tool_registry.get("validate_spec")
        if not tool:
            raise RuntimeError("validate_spec tool not configured")
        self._store.append_session_event(
            session_id,
            _session_event(
                session_id,
                turn_id,
                "tool_call_started",
                data={"tool": "validate_spec", "tool_call_id": call.id},
            ),
        )
        try:
            result = tool.invoke(call, token)
        except Exception as err:
            result = ToolResult(id=call.id, ok=False, error=str(err), parts=[])
        self._store.append_session_event(
            session_id,
            _session_event(
                session_id,
                turn_id,
                "tool_call_completed",
                data={"tool": "validate_spec", "tool_call_id": call.id, "ok": result.ok, "error": result.error},
            ),
        )
        self._store.append_session_event(
            session_id,
            _session_event(
                session_id,
                turn_id,
                "spec_validated",
                data={"ok": result.ok, "error": result.error},
            ),
        )
        msg = SessionMessage(
            id=new_message_id(),
            role="tool",
            tool_call_id=call.id,
            parts=result.parts or [],
            created_at=_now(),
        )
        self._store.append_message(session_id, msg)
        self._store.append_session_event(
            session_id,
            _session_event(session_id, turn_id, "message_added", data={"message_id": msg.id, "role": msg.role}),
        )
        return msg, result.ok

    def _requires_approval(self, definition: ToolDefinition) -> bool:
        if definition.allow_without_approval:
            return False
        if definition.requires_approval:
            return True
        if definition.kind in self.approval_policy.require_for_kinds:
            return True
        return definition.name in self.approval_policy.require_for_tools

    def _append_skipped_tool(self, session_id: str, turn_id: str, call: ToolCall, reason: str) -> None:
        self._store.append_session_event(
            session_id,
            _session_event(
                session_id,
                turn_id,
                "tool_call_skipped",
                data={"tool": call.name, "tool_call_id": call.id, "reason": reason},
            ),
        )
        self._store.append_session_event(
            session_id,
            _session_event(
                session_id,
                turn_id,
                "tool_call_completed",
                data={"tool": call.name, "tool_call_id": call.id, "ok": False, "error": reason, "skipped": True},
            ),
        )

    def _fail_turn(self, session_id: str, turn_id: str, err: Exception) -> None:
        session = self._store.get_session(session_id)
        session.status = "failed"
        session.error = str(err)
        for turn in session.turns or []:
            if turn.id == turn_id:
                turn.status = "failed"
                turn.completed_at = _now()
                turn.error = str(err)
        self._store.update_session(session)
        self._store.append_session_event(session_id, _session_event(session_id, turn_id, "turn_failed", str(err)))

    def _cancel_turn(self, session_id: str, turn_id: str, err: Exception) -> None:
        session = self._store.get_session(session_id)
        session.status = "canceled"
        session.error = str(err)
        for turn in session.turns or []:
            if turn.id == turn_id:
                turn.status = "failed"
                turn.completed_at = _now()
                turn.error = session.error
        self._store.update_session(session)
        self._store.append_session_event(session_id, _session_event(session_id, turn_id, "session_canceled", session.error))

    def _complete_turn(self, session_id: str, turn_id: str) -> None:
        session = self._store.get_session(session_id)
        session.status = "active"
        session.error = ""
        for turn in session.turns or []:
            if turn.id == turn_id:
                turn.status = "succeeded"
                turn.completed_at = _now()
        self._store.update_session(session)
        self._store.append_session_event(session_id, _session_event(session_id, turn_id, "turn_completed"))


def _build_context_text(bundle) -> str:
    out = "Workspace context:\n"
    if getattr(bundle, "agents_md", None):
        out += "AGENTS.md:\n" + (bundle.agents_md or "") + "\n\n"
    if getattr(bundle, "repo_tree", None):
        out += "REPO TREE:\n" + (bundle.repo_tree or "") + "\n\n"
    if getattr(bundle, "repo_map", None):
        out += "REPO MAP:\n" + (bundle.repo_map or "") + "\n\n"
    if getattr(bundle, "git_status", None):
        out += "GIT STATUS:\n" + (bundle.git_status or "") + "\n\n"
    return out.strip()


def _tool_message_text(parts: List[MessagePart]) -> str:
    out: List[str] = []
    for part in parts:
        if part.type == "text" and (part.text or "").strip():
            out.append(part.text or "")
        elif part.ref:
            out.append(f"[{part.type}: {part.ref}]")
    return "\n".join(out)


def _trim_text_parts(parts: List[MessagePart]) -> List[MessagePart]:
    out: List[MessagePart] = []
    for part in parts:
        if part.type != "text":
            out.append(part)
        else:
            text = (part.text or "").rstrip()
            out.append(MessagePart(**{**part.__dict__, "text": text}))
    return out


def _parse_tool_input(input_str: str) -> object:
    raw = (input_str or "").strip()
    if not raw or raw == "null":
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return raw


def _normalize_tool_input(input_str: str) -> str:
    raw = (input_str or "").strip()
    if not raw or raw == "null":
        return "{}"
    try:
        value = json.loads(raw)
        return json.dumps(value)
    except Exception:
        return raw


def _tool_call_key(call: ToolCall) -> str:
    return f"{call.name}:{_normalize_tool_input(call.input)}"


def _spec_mode_prompt(spec_path: str) -> str:
    out = ""
    out += "You are in spec-session mode.\n"
    out += "Keep the spec as the primary artifact and update it using the write_spec tool.\n"
    out += "The spec must include headings: # Goal, # Constraints / nuances, # Acceptance tests.\n"
    if spec_path.strip():
        out += f"Spec path: {spec_path}\n"
    return out.strip()


def _session_event(session_id: str, turn_id: str, event_type: str, message: str | None = None, data: dict | None = None):
    from internal.runstore.session_models import SessionEvent

    return SessionEvent(ts=_now(), session_id=session_id, turn_id=turn_id, type=event_type, message=message, data=data)


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
