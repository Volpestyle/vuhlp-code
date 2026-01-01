import path from "node:path";
import { readFile } from "node:fs/promises";
import type {
  Kit,
  Message,
  ModelRecord,
  ToolDefinition as AikitToolDefinition,
  ToolCall as AikitToolCall,
} from "@volpestyle/ai-kit-node";
import { ModelRouter, Provider } from "@volpestyle/ai-kit-node";
import type { ModelPolicy } from "../config";
import { Store } from "../runstore";
import type {
  Message as SessionMessage,
  MessagePart,
  Session,
} from "../runstore/session_models";
import { newMessageId, newToolCallId } from "../util/id";
import { defaultSpecPath, ensureSpecFile } from "../util/spec";
import { gatherContext } from "./context";
import {
  AikitAdapter,
  defaultToolRegistry,
  ToolCall,
  ToolDefinition,
  ToolRegistry,
} from "./tools";
import { SpecReadTool, SpecValidateTool, SpecWriteTool } from "./spec_tools";
import {
  ApprovalPolicy,
  defaultApprovalPolicy,
  defaultVerifyPolicy,
  VerifyPolicy,
} from "./session_policies";

export class SessionRunner {
  private running = new Set<string>();
  private router: ModelRouter;
  private policy: ModelPolicy;

  toolsFactory: (workspace: string, verify: VerifyPolicy) => ToolRegistry;
  verifyPolicy: VerifyPolicy;
  approvalPolicy: ApprovalPolicy;
  adapter: AikitAdapter;

  constructor(private store: Store, private kit: Kit, policy: ModelPolicy, router = new ModelRouter()) {
    this.router = router;
    this.policy = policy;
    this.toolsFactory = (workspace, verify) => defaultToolRegistry(workspace, verify.commands);
    this.verifyPolicy = defaultVerifyPolicy();
    this.approvalPolicy = defaultApprovalPolicy();
    this.adapter = new AikitAdapter();
  }

  setPolicy(policy: ModelPolicy): void {
    this.policy = policy;
  }

  async startTurn(sessionId: string, turnId: string): Promise<void> {
    if (this.running.has(sessionId)) {
      throw new Error(`session already running: ${sessionId}`);
    }
    this.running.add(sessionId);
    const controller = new AbortController();
    this.store.setSessionCancel(sessionId, controller);
    this.executeTurn(sessionId, turnId, controller.signal)
      .catch((err) => {
        console.error("session turn failed", { session_id: sessionId, turn_id: turnId, err });
      })
      .finally(() => {
        this.running.delete(sessionId);
      });
  }

  private async executeTurn(sessionId: string, turnId: string, signal: AbortSignal): Promise<void> {
    try {
      const session = await this.store.getSession(sessionId);
      const turnIdx = session.turns?.findIndex((turn) => turn.id === turnId) ?? -1;
      if (turnIdx === -1) {
        throw new Error(`turn not found: ${turnId}`);
      }

      const now = new Date().toISOString();
      session.status = "active";
      session.last_turn_id = turnId;
      session.turns = session.turns ?? [];
      session.turns[turnIdx].status = "running";
      session.turns[turnIdx].started_at = now;
      session.turns[turnIdx].error = "";
      await this.store.updateSession(session);
      await this.store.appendSessionEvent(sessionId, {
        ts: new Date().toISOString(),
        session_id: sessionId,
        turn_id: turnId,
        type: "turn_started",
      });

      const bundle = await gatherContext(session.workspace_path, signal);
      const model = await this.resolveModel();
      await this.store.appendSessionEvent(sessionId, {
        ts: new Date().toISOString(),
        session_id: sessionId,
        turn_id: turnId,
        type: "model_resolved",
        data: { model: model.id },
      });

      const maxTurns = 8;
      let workspaceDirty = false;
      const toolCallCounts = new Map<string, number>();

      const toolRegistry = this.toolsFactory(session.workspace_path, this.verifyPolicy);

      if (session.mode === "spec") {
        if (!session.spec_path?.trim()) {
          session.spec_path = await defaultSpecPath(session.workspace_path, `session-${session.id}`);
          await this.store.updateSession(session);
          await this.store.appendSessionEvent(sessionId, {
            ts: new Date().toISOString(),
            session_id: sessionId,
            turn_id: turnId,
            type: "spec_path_set",
            data: { spec_path: session.spec_path },
          });
        }
        const created = await ensureSpecFile(session.spec_path!);
        if (created) {
          await this.store.appendSessionEvent(sessionId, {
            ts: new Date().toISOString(),
            session_id: sessionId,
            turn_id: turnId,
            type: "spec_created",
            data: { spec_path: session.spec_path },
          });
        }
        toolRegistry.add(new SpecReadTool(session.spec_path!));
        toolRegistry.add(new SpecWriteTool(session.spec_path!));
        toolRegistry.add(new SpecValidateTool(session.spec_path!));
      }

      for (let attempt = 0; attempt < maxTurns; attempt++) {
        if (signal.aborted) {
          await this.cancelTurn(sessionId, turnId, signal.reason ?? new Error("canceled"));
          return;
        }
        const aikitMessages = await this.buildAikitMessages(session, bundle, model.provider);
        const tools = this.adapter.toAikitTools(toolRegistry.definitions());
        const { assistantText, toolCalls } = await this.streamModel(
          sessionId,
          turnId,
          model,
          aikitMessages,
          tools,
        );

        if (assistantText.trim()) {
          const msg = {
            id: newMessageId(),
            role: "assistant",
            parts: [{ type: "text", text: assistantText }],
            created_at: new Date().toISOString(),
          } as SessionMessage;
          await this.store.appendMessage(sessionId, msg);
          await this.store.appendSessionEvent(sessionId, {
            ts: new Date().toISOString(),
            session_id: sessionId,
            turn_id: turnId,
            type: "message_added",
            data: { message_id: msg.id, role: msg.role },
          });
          session.messages = session.messages ?? [];
          session.messages.push(msg);
        }

        if (!toolCalls.length) {
          if (this.verifyPolicy.autoVerify && workspaceDirty) {
            const { message, ok } = await this.invokeVerify(sessionId, turnId, toolRegistry, signal);
            session.messages = session.messages ?? [];
            session.messages.push(message);
            if (!ok) continue;
          }
          await this.completeTurn(sessionId, turnId);
          return;
        }

        let newToolCalls = 0;
        for (const call of toolCalls) {
          const tool = toolRegistry.get(call.name);
          if (!tool) throw new Error(`unknown tool: ${call.name}`);
          const callKey = toolCallKey(call);
          const count = toolCallCounts.get(callKey) ?? 0;
          if (count > 0) {
            await this.appendSkippedTool(sessionId, turnId, call, "duplicate tool call: no new info");
            continue;
          }
          toolCallCounts.set(callKey, count + 1);
          newToolCalls++;

          if (this.requiresApproval(tool.definition())) {
            session.status = "waiting_approval";
            for (const turn of session.turns ?? []) {
              if (turn.id === turnId) turn.status = "waiting_approval";
            }
            await this.store.updateSession(session);
            await this.store.requireSessionApproval(sessionId, call.id);
            await this.store.appendSessionEvent(sessionId, {
              ts: new Date().toISOString(),
              session_id: sessionId,
              turn_id: turnId,
              type: "approval_requested",
              data: { tool: call.name, tool_call_id: call.id },
            });
            const decision = await this.store.waitForSessionApproval(sessionId, call.id, signal);
            if (decision.action === "deny") {
              await this.store.appendSessionEvent(sessionId, {
                ts: new Date().toISOString(),
                session_id: sessionId,
                turn_id: turnId,
                type: "approval_denied",
                data: { tool: call.name, tool_call_id: call.id, reason: decision.reason },
              });
              throw new Error("approval denied");
            }
            session.status = "active";
            for (const turn of session.turns ?? []) {
              if (turn.id === turnId) turn.status = "running";
            }
            await this.store.updateSession(session);
            await this.store.appendSessionEvent(sessionId, {
              ts: new Date().toISOString(),
              session_id: sessionId,
              turn_id: turnId,
              type: "approval_granted",
              data: { tool: call.name, tool_call_id: call.id, reason: decision.reason },
            });
          }

          await this.store.appendSessionEvent(sessionId, {
            ts: new Date().toISOString(),
            session_id: sessionId,
            turn_id: turnId,
            type: "tool_call_started",
            data: { tool: call.name, tool_call_id: call.id },
          });
          const result = await tool.invoke(call, signal).catch((err: Error) => {
            return { id: call.id, ok: false, error: err.message, parts: [] };
          });
          await this.store.appendSessionEvent(sessionId, {
            ts: new Date().toISOString(),
            session_id: sessionId,
            turn_id: turnId,
            type: "tool_call_completed",
            data: { tool: call.name, tool_call_id: call.id, ok: result.ok, error: result.error },
          });

          const toolMsg: SessionMessage = {
            id: newMessageId(),
            role: "tool",
            tool_call_id: call.id,
            parts: result.parts ?? [],
            created_at: new Date().toISOString(),
          };
          await this.store.appendMessage(sessionId, toolMsg);
          await this.store.appendSessionEvent(sessionId, {
            ts: new Date().toISOString(),
            session_id: sessionId,
            turn_id: turnId,
            type: "message_added",
            data: { message_id: toolMsg.id, role: toolMsg.role },
          });
          session.messages = session.messages ?? [];
          session.messages.push(toolMsg);

          const def = tool.definition();
          if ((def.kind === "write" || def.kind === "exec") && !(session.mode === "spec" && call.name === "write_spec")) {
            workspaceDirty = true;
          }

          if (session.mode === "spec" && call.name === "write_spec") {
            const { message, ok } = await this.invokeSpecValidate(sessionId, turnId, toolRegistry, signal);
            session.messages = session.messages ?? [];
            session.messages.push(message);
            if (!ok) continue;
          }

          if (!result.ok) break;
        }

        if (newToolCalls === 0) {
          if (this.verifyPolicy.autoVerify && workspaceDirty) {
            const { message, ok } = await this.invokeVerify(sessionId, turnId, toolRegistry, signal);
            session.messages = session.messages ?? [];
            session.messages.push(message);
            if (!ok) continue;
          }
          await this.completeTurn(sessionId, turnId);
          return;
        }
      }

      throw new Error("max turn iterations reached");
    } catch (err: unknown) {
      await this.failTurn(sessionId, turnId, err as Error);
      throw err;
    }
  }

  private async resolveModel(): Promise<ModelRecord> {
    const records = await this.kit.listModelRecords();
    const resolved = this.router.resolve(records, {
      constraints: {
        requireTools: this.policy.require_tools,
        requireVision: this.policy.require_vision,
        maxCostUsd: this.policy.max_cost_usd,
      },
      preferredModels: this.policy.preferred_models,
    });
    return resolved.primary;
  }

  private async buildAikitMessages(
    session: Session,
    bundle: Awaited<ReturnType<typeof gatherContext>>,
    provider: Provider,
  ): Promise<Message[]> {
    const messages: SessionMessage[] = [];
    if (session.system_prompt?.trim()) {
      messages.push({
        id: newMessageId(),
        role: "system",
        parts: [{ type: "text", text: session.system_prompt }],
        created_at: new Date().toISOString(),
      });
    }
    if (session.mode === "spec") {
      messages.push({
        id: newMessageId(),
        role: "system",
        parts: [{ type: "text", text: specModePrompt(session.spec_path ?? "") }],
        created_at: new Date().toISOString(),
      });
    }
    const contextText = buildContextText(bundle);
    if (contextText) {
      messages.push({
        id: newMessageId(),
        role: "system",
        parts: [{ type: "text", text: contextText }],
        created_at: new Date().toISOString(),
      });
    }
    if (session.mode === "spec" && session.spec_path) {
      try {
        const content = await readFile(session.spec_path, "utf8");
        if (content.trim()) {
          messages.push({
            id: newMessageId(),
            role: "system",
            parts: [{ type: "text", text: `CURRENT SPEC (${session.spec_path}):\n${content}` }],
            created_at: new Date().toISOString(),
          });
        }
      } catch {
        // ignore
      }
    }
    const base = session.messages ?? [];
    const prepared = this.prepareSessionMessages(base, provider);
    const allMessages = messages.concat(prepared);
    return this.toAikitMessages(session.id, allMessages);
  }

  private prepareSessionMessages(messages: SessionMessage[], provider: Provider): SessionMessage[] {
    if (provider !== Provider.OpenAI) return messages;
    const out: SessionMessage[] = [];
    for (const msg of messages) {
      if (msg.role !== "tool") {
        out.push(msg);
        continue;
      }
      let text = toolMessageText(msg.parts ?? []);
      if (!text.trim()) text = "(no output)";
      const label = msg.tool_call_id ? `TOOL OUTPUT (${msg.tool_call_id})` : "TOOL OUTPUT";
      out.push({
        id: msg.id,
        role: "assistant",
        parts: [{ type: "text", text: `${label}:\n${text}` }],
        created_at: msg.created_at,
      });
    }
    return out;
  }

  private async toAikitMessages(sessionId: string, messages: SessionMessage[]): Promise<Message[]> {
    const out: Message[] = [];
    for (const msg of messages) {
      const parts: Message["content"] = [];
      for (const part of msg.parts ?? []) {
        if (part.type === "text") {
          parts.push({ type: "text", text: part.text ?? "" });
        } else if (part.type === "image") {
          const img = await this.loadImageAttachment(sessionId, part.ref ?? "", part.mime_type ?? "");
          if (img) {
            parts.push({ type: "image", image: img });
          } else {
            parts.push({ type: "text", text: `[image: ${part.ref}]` });
          }
        } else {
          if (part.ref) {
            parts.push({ type: "text", text: `[${part.type}: ${part.ref}]` });
          } else if (part.text) {
            parts.push({ type: "text", text: part.text });
          }
        }
      }
      out.push({ role: msg.role, content: parts, toolCallId: msg.tool_call_id });
    }
    return out;
  }

  private async loadImageAttachment(sessionId: string, ref: string, mimeType: string): Promise<{ base64: string; mediaType: string } | null> {
    if (!ref) return null;
    const base = path.join(this.store.dataDirectory(), "sessions", sessionId);
    const target = path.join(base, ref.replace(/^\/+/, ""));
    const clean = path.normalize(target);
    if (!clean.startsWith(base)) return null;
    try {
      const buf = await readFile(clean);
      return { base64: Buffer.from(buf).toString("base64"), mediaType: mimeType || "image/png" };
    } catch {
      return null;
    }
  }

  private async streamModel(
    sessionId: string,
    turnId: string,
    model: ModelRecord,
    messages: Message[],
    tools: AikitToolDefinition[],
  ): Promise<{ assistantText: string; toolCalls: ToolCall[] }> {
    const stream = this.kit.streamGenerate({
      provider: model.provider,
      model: model.providerModelId,
      messages,
      tools,
      stream: true,
    });
    let assistantText = "";
    const callsById = new Map<string, ToolCall>();
    const callOrder: string[] = [];

    for await (const chunk of stream) {
      if (chunk.type === "delta") {
        if (chunk.textDelta) {
          assistantText += chunk.textDelta;
          await this.store.appendSessionEvent(sessionId, {
            ts: new Date().toISOString(),
            session_id: sessionId,
            turn_id: turnId,
            type: "model_output_delta",
            data: { delta: chunk.textDelta },
          });
        }
      } else if (chunk.type === "tool_call") {
        if (chunk.call) {
          const call = this.adapter.fromAikitCall(chunk.call as AikitToolCall);
          if (!call.id) call.id = newToolCallId();
          const existing = callsById.get(call.id);
          if (!existing) {
            callsById.set(call.id, call);
            callOrder.push(call.id);
          } else {
            if (call.name) existing.name = call.name;
            if (call.input && call.input !== "{}") existing.input = call.input;
            callsById.set(call.id, existing);
          }
        }
      } else if (chunk.type === "message_end") {
        await this.store.appendSessionEvent(sessionId, {
          ts: new Date().toISOString(),
          session_id: sessionId,
          turn_id: turnId,
          type: "model_output_completed",
          data: { finish_reason: chunk.finishReason },
        });
      } else if (chunk.type === "error") {
        throw new Error(`model error: ${chunk.error.message}`);
      }
    }

    const toolCalls: ToolCall[] = [];
    for (const id of callOrder) {
      const call = callsById.get(id);
      if (call) toolCalls.push(call);
    }
    return { assistantText, toolCalls };
  }

  private async invokeVerify(
    sessionId: string,
    turnId: string,
    toolRegistry: ToolRegistry,
    signal: AbortSignal,
  ): Promise<{ message: SessionMessage; ok: boolean }> {
    const verifyCall: ToolCall = { id: newToolCallId(), name: "verify", input: "{}" };
    const tool = toolRegistry.get("verify");
    if (!tool) throw new Error("verify tool not configured");
    if (this.requiresApproval(tool.definition())) {
      await this.store.requireSessionApproval(sessionId, verifyCall.id);
      await this.store.appendSessionEvent(sessionId, {
        ts: new Date().toISOString(),
        session_id: sessionId,
        turn_id: turnId,
        type: "approval_requested",
        data: { tool: "verify", tool_call_id: verifyCall.id },
      });
      const decision = await this.store.waitForSessionApproval(sessionId, verifyCall.id, signal);
      if (decision.action === "deny") {
        throw new Error("verification denied");
      }
    }
    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      turn_id: turnId,
      type: "tool_call_started",
      data: { tool: "verify", tool_call_id: verifyCall.id },
    });
    const result = await tool.invoke(verifyCall, signal).catch((err: Error) => ({
      id: verifyCall.id,
      ok: false,
      error: err.message,
      parts: [],
    }));
    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      turn_id: turnId,
      type: "tool_call_completed",
      data: { tool: "verify", tool_call_id: verifyCall.id, ok: result.ok, error: result.error },
    });
    const msg: SessionMessage = {
      id: newMessageId(),
      role: "tool",
      tool_call_id: verifyCall.id,
      parts: result.parts ?? [],
      created_at: new Date().toISOString(),
    };
    await this.store.appendMessage(sessionId, msg);
    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      turn_id: turnId,
      type: "message_added",
      data: { message_id: msg.id, role: msg.role },
    });
    return { message: msg, ok: result.ok };
  }

  private async invokeSpecValidate(
    sessionId: string,
    turnId: string,
    toolRegistry: ToolRegistry,
    signal: AbortSignal,
  ): Promise<{ message: SessionMessage; ok: boolean }> {
    const call: ToolCall = { id: newToolCallId(), name: "validate_spec", input: "{}" };
    const tool = toolRegistry.get("validate_spec");
    if (!tool) throw new Error("validate_spec tool not configured");

    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      turn_id: turnId,
      type: "tool_call_started",
      data: { tool: "validate_spec", tool_call_id: call.id },
    });
    const result = await tool.invoke(call, signal).catch((err: Error) => ({
      id: call.id,
      ok: false,
      error: err.message,
      parts: [],
    }));
    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      turn_id: turnId,
      type: "tool_call_completed",
      data: { tool: "validate_spec", tool_call_id: call.id, ok: result.ok, error: result.error },
    });
    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      turn_id: turnId,
      type: "spec_validated",
      data: { ok: result.ok, error: result.error },
    });

    const msg: SessionMessage = {
      id: newMessageId(),
      role: "tool",
      tool_call_id: call.id,
      parts: result.parts ?? [],
      created_at: new Date().toISOString(),
    };
    await this.store.appendMessage(sessionId, msg);
    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      turn_id: turnId,
      type: "message_added",
      data: { message_id: msg.id, role: msg.role },
    });
    return { message: msg, ok: result.ok };
  }

  private requiresApproval(def: ToolDefinition): boolean {
    if (def.allowWithoutApproval) return false;
    if (def.requiresApproval) return true;
    if (this.approvalPolicy.requireForKinds.includes(def.kind)) return true;
    return this.approvalPolicy.requireForTools.includes(def.name);
  }

  private async appendSkippedTool(
    sessionId: string,
    turnId: string,
    call: ToolCall,
    reason: string,
  ): Promise<void> {
    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      turn_id: turnId,
      type: "tool_call_skipped",
      data: { tool: call.name, tool_call_id: call.id, reason },
    });
    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      turn_id: turnId,
      type: "tool_call_completed",
      data: { tool: call.name, tool_call_id: call.id, ok: false, error: reason, skipped: true },
    });
  }

  private async failTurn(sessionId: string, turnId: string, err: Error): Promise<void> {
    const session = await this.store.getSession(sessionId);
    session.status = "failed";
    session.error = err.message;
    for (const turn of session.turns ?? []) {
      if (turn.id === turnId) {
        turn.status = "failed";
        turn.completed_at = new Date().toISOString();
        turn.error = err.message;
      }
    }
    await this.store.updateSession(session);
    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      turn_id: turnId,
      type: "turn_failed",
      message: err.message,
    });
  }

  private async cancelTurn(sessionId: string, turnId: string, err: unknown): Promise<void> {
    const session = await this.store.getSession(sessionId);
    session.status = "canceled";
    session.error = (err as Error)?.message ?? "canceled";
    for (const turn of session.turns ?? []) {
      if (turn.id === turnId) {
        turn.status = "failed";
        turn.completed_at = new Date().toISOString();
        turn.error = session.error;
      }
    }
    await this.store.updateSession(session);
    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      turn_id: turnId,
      type: "session_canceled",
      message: session.error,
    });
  }

  private async completeTurn(sessionId: string, turnId: string): Promise<void> {
    const session = await this.store.getSession(sessionId);
    session.status = "active";
    session.error = "";
    for (const turn of session.turns ?? []) {
      if (turn.id === turnId) {
        turn.status = "succeeded";
        turn.completed_at = new Date().toISOString();
      }
    }
    await this.store.updateSession(session);
    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      turn_id: turnId,
      type: "turn_completed",
    });
  }
}

function buildContextText(bundle: Awaited<ReturnType<typeof gatherContext>>): string {
  let out = "Workspace context:\n";
  if (bundle.agents_md) {
    out += "AGENTS.md:\n" + bundle.agents_md + "\n\n";
  }
  if (bundle.repo_tree) {
    out += "REPO TREE:\n" + bundle.repo_tree + "\n\n";
  }
  if (bundle.repo_map) {
    out += "REPO MAP:\n" + bundle.repo_map + "\n\n";
  }
  if (bundle.git_status) {
    out += "GIT STATUS:\n" + bundle.git_status + "\n\n";
  }
  return out.trim();
}

function toolMessageText(parts: MessagePart[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text?.trim()) {
      out.push(part.text);
    } else if (part.ref?.trim()) {
      out.push(`[${part.type}: ${part.ref}]`);
    }
  }
  return out.join("\n");
}

function normalizeToolInput(input: string): string {
  const raw = input?.trim();
  if (!raw || raw === "null") return "{}";
  try {
    const value = JSON.parse(raw);
    return JSON.stringify(value);
  } catch {
    return raw;
  }
}

function toolCallKey(call: ToolCall): string {
  return `${call.name}:${normalizeToolInput(call.input)}`;
}

function specModePrompt(specPath: string): string {
  let out = "";
  out += "You are in spec-session mode.\n";
  out += "Keep the spec as the primary artifact and update it using the write_spec tool.\n";
  out += "The spec must include headings: # Goal, # Constraints / nuances, # Acceptance tests.\n";
  if (specPath.trim()) out += `Spec path: ${specPath}\n`;
  return out.trim();
}
