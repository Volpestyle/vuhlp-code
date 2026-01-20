import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  ApprovalResolution,
  CliPermissionsMode,
  EventEnvelope,
  NodePatchEvent,
  NodeState,
  ToolCall,
  TurnStatus,
  UUID
} from "@vuhlp/contracts";
import { asJsonObject, getNumber, getString, parseJsonValue, type JsonObject } from "./json.js";
import { parseCliEventLine, parseCliStreamEndLine, isIgnoredEvent, type ParsedCliEvent, type ParsedCliEventResult } from "./cli-protocol.js";
import { ConsoleLogger, type Logger } from "./logger.js";
import { normalizeCliEvent } from "./normalize.js";
import type {
  CliProviderConfig,
  ProviderAdapter,
  ProviderErrorListener,
  ProviderEventListener,
  ProviderTurnInput
} from "./types.js";

interface ListenerSet<T> {
  add(listener: (value: T) => void): () => void;
  emit(value: T): void;
}

function createListenerSet<T>(): ListenerSet<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    add(listener: (value: T) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(value: T) {
      for (const listener of listeners) {
        listener(value);
      }
    }
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export class CliProviderAdapter implements ProviderAdapter {
  private readonly config: CliProviderConfig;
  private readonly logger: Logger;
  private readonly debugCli: boolean;
  private process: ReturnType<typeof spawn> | null = null;
  private readonly eventListeners = createListenerSet<EventEnvelope>();
  private readonly errorListeners = createListenerSet<Error>();
  private readonly pendingApprovals = new Set<UUID>();
  private readonly resolvedApprovals = new Set<UUID>();
  private shouldCloseAfterTurn = false;
  private awaitingTurn = false;
  private sawTurnOutput = false;
  private hadProcessError = false;
  private streamBuffer: { content: string; thinking: string } | null = null;
  private streamToolBlocks = new Map<
    number,
    { id?: string; name?: string; inputJson: string; hasInitialInput: boolean }
  >();
  private nextSyntheticToolIndex = -1;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private loggedStreamJsonEof = false;
  private loggedStreamJsonInput = false;

  constructor(config: CliProviderConfig, logger: Logger = new ConsoleLogger()) {
    this.config = config;
    this.logger = logger;
    this.debugCli = ["1", "true", "yes", "on"].includes(
      (process.env.VUHLP_DEBUG_CLI ?? "").toLowerCase()
    );
  }

  onEvent(listener: ProviderEventListener): () => void {
    return this.eventListeners.add(listener);
  }

  onError(listener: ProviderErrorListener): () => void {
    return this.errorListeners.add(listener);
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }
    await this.spawnProcess();
  }

  async send(input: ProviderTurnInput): Promise<void> {
    await this.ensureProcess();
    const closeAfterPrompt = this.shouldCloseAfterPrompt();
    if (this.shouldUseStreamJsonInput() && !this.loggedStreamJsonInput) {
      this.logger.info("stream-json input enabled; keeping stdin open between turns", {
        nodeId: this.config.nodeId,
        provider: this.config.provider
      });
      this.loggedStreamJsonInput = true;
    }
    if (closeAfterPrompt && this.config.protocol === "stream-json" && !this.loggedStreamJsonEof) {
      this.logger.info("stream-json prompts require stdin EOF; closing input after prompt", {
        nodeId: this.config.nodeId,
        provider: this.config.provider
      });
      this.loggedStreamJsonEof = true;
    }
    this.shouldCloseAfterTurn = !this.config.resume || closeAfterPrompt;
    this.awaitingTurn = true;
    this.sawTurnOutput = false;
    this.hadProcessError = false;
    this.streamBuffer = { content: "", thinking: "" };
    this.streamToolBlocks.clear();
    this.nextSyntheticToolIndex = -1;
    this.emitTurnStatus("turn.started");
    this.emitTurnStatus("waiting_for_model");
    this.startHeartbeat();
    const payload = this.serializePrompt(input);
    await this.writeLine(payload);
    if (closeAfterPrompt) {
      this.endInput();
    }
  }

  async interrupt(): Promise<void> {
    if (!this.process) {
      return;
    }
    try {
      this.process.kill("SIGINT");
      if (this.awaitingTurn) {
        this.emitTurnStatus("turn.interrupted");
        this.stopHeartbeat();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("failed to interrupt provider process", {
        nodeId: this.config.nodeId,
        message
      });
    }
  }

  async resolveApproval(approvalId: UUID, resolution: ApprovalResolution): Promise<void> {
    await this.ensureProcess();
    if (!this.pendingApprovals.has(approvalId) && !this.resolvedApprovals.has(approvalId)) {
      this.logger.warn("approval resolution without pending request", {
        nodeId: this.config.nodeId,
        approvalId
      });
    }
    await this.sendApprovalResolution(approvalId, resolution, "ui");
  }

  async resetSession(): Promise<void> {
    if (!this.process) {
      await this.spawnProcess();
      return;
    }
    if (this.config.resetCommands.length === 0) {
      this.logger.warn("reset requested without reset commands", { nodeId: this.config.nodeId });
      return;
    }
    for (const command of this.config.resetCommands) {
      await this.writeLine(command);
    }
  }

  async close(): Promise<void> {
    if (!this.process) {
      return;
    }
    const processRef = this.process;
    this.process = null;
    processRef.kill();
    this.stopHeartbeat();
    this.emitConnectionPatch("disconnected");
  }

  getSessionId(): string | null {
    return this.process?.pid ? String(this.process.pid) : null;
  }

  private async spawnProcess(): Promise<void> {
    this.logger.info("starting provider process", {
      nodeId: this.config.nodeId,
      provider: this.config.provider,
      command: this.config.command,
      args: this.config.args ?? [],
      protocol: this.config.protocol,
      resume: this.config.resume,
      nativeToolHandling: this.config.nativeToolHandling ?? "vuhlp"
    });

    const env = this.config.env ? { ...process.env, ...this.config.env } : process.env;
    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.process = child;
    this.emitConnectionPatch("idle");

    child.on("error", (error: Error) => {
      this.hadProcessError = true;
      this.awaitingTurn = false;
      this.logger.error("provider process error", { nodeId: this.config.nodeId, message: error.message });
      this.errorListeners.emit(error);
      this.emitTurnStatus("turn.failed", error.message);
      this.stopHeartbeat();
      this.emitConnectionPatch("disconnected");
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.process === child) {
        this.process = null;
      }
      this.logger.warn("provider process exited", {
        nodeId: this.config.nodeId,
        code: code ?? null,
        signal: signal ?? null
      });
      if (this.config.protocol === "raw" && this.awaitingTurn && !this.hadProcessError) {
        const content = this.sawTurnOutput ? "" : this.formatRawExitMessage(code, signal);
        this.emitRawFinal(content);
        this.awaitingTurn = false;
        this.sawTurnOutput = false;
      } else if (
        (this.config.protocol === "stream-json" || this.config.protocol === "jsonl") &&
        this.awaitingTurn &&
        !this.hadProcessError
      ) {
        void this.handleStreamEnd();
      }
      this.emitConnectionPatch("disconnected");
    });

    const stdout = child.stdout;
    if (stdout) {
      stdout.setEncoding("utf8");
      const reader = createInterface({ input: stdout });
      reader.on("line", (line) => {
        void this.handleLine(line, "stdout");
      });
    }

    const stderr = child.stderr;
    if (stderr) {
      stderr.setEncoding("utf8");
      const reader = createInterface({ input: stderr });
      reader.on("line", (line) => {
        void this.handleLine(line, "stderr");
      });
    }
  }

  private async handleLine(line: string, source: "stdout" | "stderr"): Promise<void> {
    const usesStructuredOutput = this.config.protocol !== "raw";
    const trimmed = line.trim();
    const looksLikeJson = trimmed.startsWith("{") && trimmed.endsWith("}");
    const capturedToolUse = usesStructuredOutput && looksLikeJson
      ? this.captureStreamToolUse(trimmed)
      : false;
    const parseResult: ParsedCliEventResult = usesStructuredOutput && !capturedToolUse ? parseCliEventLine(line) : null;
    let handledStructured = capturedToolUse;

    if (parseResult && !isIgnoredEvent(parseResult)) {
      handledStructured = true;
      await this.handleParsedEvent(parseResult);
    } else if (isIgnoredEvent(parseResult)) {
      // Recognized event type but intentionally not emitted (e.g., message_start, content_block_stop)
      handledStructured = true;
    } else if (usesStructuredOutput && parseCliStreamEndLine(line)) {
      handledStructured = true;
      await this.handleStreamEnd();
    } else if (usesStructuredOutput && looksLikeJson && !handledStructured) {
      // Truly unrecognized JSON event - log for debugging
      const excerpt =
        this.debugCli || trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 200)}...`;
      this.logger.debug("unrecognized JSON event type", {
        nodeId: this.config.nodeId,
        line: excerpt
      });
    }

    const shouldLog = source === "stderr" || this.config.protocol === "raw" || !handledStructured;
    if (shouldLog) {
      this.emitNodeLog(source, line);
    }

    if (this.config.protocol !== "raw" && source === "stderr") {
      return;
    }

    if (usesStructuredOutput && handledStructured) {
      return;
    }

    if (usesStructuredOutput && looksLikeJson) {
      return;
    }

    if (this.config.protocol === "raw") {
      if (!this.awaitingTurn) {
        return;
      }
      this.sawTurnOutput = true;
    }
    const delta = source === "stderr" ? `stderr: ${line}` : line;

    // For structured protocols, unparsed stdout lines are logs, not content.
    if (this.config.protocol !== "raw" && source === "stdout" && !delta.startsWith("stderr:")) {
      return;
    }

    const event = normalizeCliEvent(this.eventContext(), {
      type: "message.assistant.delta",
      delta: `${delta}\n`
    });
    this.eventListeners.emit(event);
  }

  private async handleParsedEvent(event: ParsedCliEvent): Promise<void> {
    let adjustedEvent = event;
    if (event.type === "message.assistant.delta") {
      const normalizedDelta = this.normalizeStreamDelta("content", event.delta);
      if (!normalizedDelta) {
        return;
      }
      this.appendStreamDelta("content", normalizedDelta);
      if (normalizedDelta !== event.delta) {
        adjustedEvent = { ...event, delta: normalizedDelta };
      }
    }
    if (event.type === "message.assistant.thinking.delta") {
      const normalizedDelta = this.normalizeStreamDelta("thinking", event.delta);
      if (!normalizedDelta) {
        return;
      }
      this.appendStreamDelta("thinking", normalizedDelta);
      if (normalizedDelta !== event.delta) {
        adjustedEvent = { ...event, delta: normalizedDelta };
      }
    }
    if (event.type === "message.assistant.final") {
      if (this.config.protocol === "stream-json") {
        if (!this.streamBuffer) {
          this.streamBuffer = { content: "", thinking: "" };
        }
        this.streamBuffer.content = event.content;
        return;
      }
      const toolCalls = this.buildToolCalls();
      if (toolCalls.length > 0) {
        adjustedEvent = {
          ...event,
          toolCalls
        };
      }
      this.streamBuffer = null;
    }

    if (event.type === "approval.requested") {
      this.pendingApprovals.add(event.approvalId);
      if (event.tool?.name) {
        this.emitTurnStatus("awaiting_approval", `awaiting approval: ${event.tool.name}`);
      } else {
        this.emitTurnStatus("awaiting_approval");
      }
      this.eventListeners.emit(normalizeCliEvent(this.eventContext(), event));
      if (this.config.permissionsMode === "skip") {
        await this.sendApprovalResolution(event.approvalId, { status: "approved" }, "auto");
      }
      return;
    }

    if (event.type === "approval.resolved") {
      if (this.resolvedApprovals.has(event.approvalId)) {
        return;
      }
      this.resolvedApprovals.add(event.approvalId);
      this.pendingApprovals.delete(event.approvalId);
      this.eventListeners.emit(normalizeCliEvent(this.eventContext(), event));
      return;
    }

    if (event.type === "tool.proposed") {
      if (event.tool?.name) {
        this.emitTurnStatus("tool.pending", `tool pending: ${event.tool.name}`);
      } else {
        this.emitTurnStatus("tool.pending");
      }
    }

    this.eventListeners.emit(normalizeCliEvent(this.eventContext(), adjustedEvent));

    if (adjustedEvent.type === "message.assistant.final") {
      await this.completeTurn();
    }
  }

  private normalizeStreamDelta(kind: "content" | "thinking", delta: string): string | null {
    if (!delta) {
      return null;
    }
    const buffer = this.streamBuffer;
    if (!buffer) {
      return delta;
    }
    const existing = kind === "content" ? buffer.content : buffer.thinking;
    if (!existing) {
      return delta;
    }
    if (delta.length > existing.length && delta.startsWith(existing)) {
      const remainder = delta.slice(existing.length);
      this.logger.debug("normalized snapshot stream delta", {
        nodeId: this.config.nodeId,
        kind,
        previousLength: existing.length,
        incomingLength: delta.length,
        emittedLength: remainder.length
      });
      return remainder;
    }
    return delta;
  }

  private appendStreamDelta(kind: "content" | "thinking", delta: string): void {
    if (!delta) {
      return;
    }
    if (!this.streamBuffer) {
      this.streamBuffer = { content: "", thinking: "" };
    }
    if (kind === "content") {
      this.streamBuffer.content += delta;
    } else {
      this.streamBuffer.thinking += delta;
    }
  }

  private async handleStreamEnd(): Promise<void> {
    if (!this.awaitingTurn) {
      return;
    }
    const toolCalls = this.buildToolCalls();
    const buffer = this.streamBuffer;
    if (buffer && (buffer.content.length > 0 || buffer.thinking.length > 0 || toolCalls.length > 0)) {
      if (buffer.thinking.length > 0) {
        const thinkingFinal = normalizeCliEvent(this.eventContext(), {
          type: "message.assistant.thinking.final",
          content: buffer.thinking
        });
        this.eventListeners.emit(thinkingFinal);
      }
      const finalEvent = normalizeCliEvent(this.eventContext(), {
        type: "message.assistant.final",
        content: buffer.content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined
      });
      this.eventListeners.emit(finalEvent);
    }
    this.streamBuffer = null;
    await this.completeTurn();
  }

  private captureStreamToolUse(line: string): boolean {
    if (this.config.protocol === "raw") {
      return false;
    }
    if (this.config.provider === "gemini") {
      return false;
    }
    const parsed = parseJsonValue(line);
    if (!parsed) {
      return false;
    }
    const obj = asJsonObject(parsed);
    if (!obj) {
      return false;
    }
    const captured = this.trackToolEvent(obj);
    if (captured && this.debugCli) {
      this.logger.debug("captured structured tool event", {
        nodeId: this.config.nodeId,
        line
      });
    }
    return captured;
  }

  private trackToolEvent(obj: JsonObject): boolean {
    const type = getString(obj.type);
    if (!type) {
      return false;
    }
    if (type === "stream_event") {
      const inner = asJsonObject(obj.event ?? null);
      if (inner) {
        return this.trackToolEvent(inner);
      }
      return false;
    }
    if (type === "content_block_start") {
      const index = getNumber(obj.index);
      const contentBlock = asJsonObject(obj.content_block ?? null);
      if (index === null || !contentBlock) {
        return false;
      }
      const blockType = getString(contentBlock.type);
      if (blockType !== "tool_use") {
        return false;
      }
      const id = getString(contentBlock.id ?? null) ?? undefined;
      const name = getString(contentBlock.name ?? null) ?? undefined;
      const input = asJsonObject(contentBlock.input ?? null);
      const inputJson = input ? JSON.stringify(input) : "";
      this.streamToolBlocks.set(index, { id, name, inputJson, hasInitialInput: inputJson.length > 0 });
      return true;
    }
    if (type === "content_block_delta") {
      const index = getNumber(obj.index);
      const delta = asJsonObject(obj.delta ?? null);
      if (index === null || !delta) {
        return false;
      }
      const deltaType = getString(delta.type ?? null);
      if (deltaType !== "input_json_delta") {
        return false;
      }
      const partialJson = getString(delta.partial_json ?? null);
      if (!partialJson) {
        return false;
      }
      const entry = this.streamToolBlocks.get(index);
      if (entry) {
        if (entry.hasInitialInput) {
          entry.inputJson = "";
          entry.hasInitialInput = false;
        }
        entry.inputJson += partialJson;
        return true;
      }
      this.streamToolBlocks.set(index, { inputJson: partialJson, hasInitialInput: false });
      return true;
    }
    if (type === "tool_use") {
      const tool = asJsonObject(obj.tool ?? null);
      const name = getString(obj.tool_name) ?? getString(obj.name) ?? (tool ? getString(tool.name) : null);
      const id =
        getString(obj.tool_id) ?? getString(obj.id) ?? (tool ? getString(tool.id) : null) ?? undefined;
      const parameters =
        asJsonObject(obj.parameters ?? null) ??
        asJsonObject(obj.args ?? null) ??
        asJsonObject(obj.input ?? null) ??
        (tool ? asJsonObject(tool.parameters ?? null) ?? asJsonObject(tool.args ?? null) ?? asJsonObject(tool.input ?? null) : null);
      if (!name || !parameters) {
        return false;
      }
      const inputJson = JSON.stringify(parameters);
      const index = this.nextSyntheticToolIndex;
      this.nextSyntheticToolIndex -= 1;
      this.streamToolBlocks.set(index, { id, name, inputJson, hasInitialInput: true });
      return true;
    }
    if (type === "tool_result") {
      return true;
    }
    return false;
  }

  private buildToolCalls(): ToolCall[] {
    if (this.streamToolBlocks.size === 0) {
      return [];
    }
    const toolCalls: ToolCall[] = [];
    for (const entry of this.streamToolBlocks.values()) {
      if (!entry.name) {
        continue;
      }
      const args = this.parseToolArgs(entry.inputJson);
      const mapped = this.mapToolUse(entry.name, args);
      if (!mapped) {
        this.logger.debug("ignored provider tool", { nodeId: this.config.nodeId, tool: entry.name });
        continue;
      }
      const id = entry.id ?? randomUUID();
      toolCalls.push({ id, name: mapped.name, args: mapped.args });
    }
    this.streamToolBlocks.clear();
    return toolCalls;
  }

  private parseToolArgs(inputJson: string): JsonObject {
    const trimmed = inputJson.trim();
    if (!trimmed) {
      return {};
    }
    const parsed = parseJsonValue(trimmed);
    const obj = parsed ? asJsonObject(parsed) : null;
    if (!obj) {
      const input =
        this.debugCli || trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 200)}...`;
      this.logger.warn("failed to parse tool input JSON", {
        nodeId: this.config.nodeId,
        input
      });
      return {};
    }
    return obj;
  }

  private mapToolUse(name: string, args: JsonObject): { name: string; args: JsonObject } | null {
    const trimmedName = name.trim();
    const normalized = trimmedName.toLowerCase();
    if (!trimmedName) {
      return null;
    }
    if (this.config.nativeToolHandling === "provider") {
      return {
        name: "provider_tool",
        args: {
          name: trimmedName,
          input: args,
          providerHandled: true
        }
      };
    }
    if (normalized === "task") {
      return { name: "spawn_node", args: this.mapTaskArgs(args) };
    }
    if (normalized === "bash") {
      const cmd = this.pickString(args, ["cmd", "command", "script"]);
      if (!cmd) {
        return null;
      }
      return { name: "command", args: { cmd } };
    }
    return { name: "provider_tool", args: { name: normalized, input: args } };
  }

  private mapTaskArgs(args: JsonObject): JsonObject {
    const label =
      this.pickString(args, ["label", "title", "name", "description"]) ?? "Subagent";
    const alias = this.pickString(args, ["alias"]);
    const roleTemplate =
      this.pickString(args, ["roleTemplate", "role", "template"]) ?? "implementer";
    const instructions = this.pickString(args, ["instructions", "prompt", "task", "description"]);
    const provider = this.pickString(args, ["provider"]);
    const input =
      asJsonObject(args.input ?? null) ??
      asJsonObject(args.context ?? null) ??
      asJsonObject(args.payload ?? null);

    const mapped: JsonObject = {
      label,
      roleTemplate
    };
    if (alias) {
      mapped.alias = alias;
    }
    if (instructions) {
      mapped.instructions = instructions;
    }
    if (provider) {
      mapped.provider = provider;
    }
    if (input) {
      mapped.input = input;
    }
    return mapped;
  }

  private pickString(obj: JsonObject, keys: string[]): string | null {
    for (const key of keys) {
      const value = obj[key];
      const str = value !== undefined ? getString(value) : null;
      if (str) {
        return str;
      }
    }
    return null;
  }

  private async completeTurn(): Promise<void> {
    this.awaitingTurn = false;
    this.sawTurnOutput = false;
    this.emitTurnStatus("turn.completed");
    this.stopHeartbeat();
    if (this.shouldCloseAfterTurn) {
      await this.close();
    }
  }

  private eventContext() {
    return {
      runId: this.config.runId,
      nodeId: this.config.nodeId,
      now: nowIso,
      makeId: randomUUID
    };
  }

  private emitConnectionPatch(status: "connected" | "idle" | "disconnected"): void {
    const patch: Partial<NodeState> = {
      connection: {
        status,
        streaming: status === "connected",
        lastHeartbeatAt: nowIso(),
        lastOutputAt: nowIso()
      }
    };
    const event: NodePatchEvent = {
      id: randomUUID(),
      runId: this.config.runId,
      ts: nowIso(),
      type: "node.patch",
      nodeId: this.config.nodeId,
      patch
    };
    this.eventListeners.emit(event);
  }

  private emitTurnStatus(status: TurnStatus, detail?: string): void {
    const context = this.eventContext();
    const event: EventEnvelope = {
      id: context.makeId(),
      runId: context.runId,
      ts: context.now(),
      type: "turn.status",
      nodeId: context.nodeId,
      status,
      detail
    };
    this.eventListeners.emit(event);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), 2000);
    this.emitHeartbeat();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private emitHeartbeat(): void {
    const context = this.eventContext();
    const event: EventEnvelope = {
      id: context.makeId(),
      runId: context.runId,
      ts: context.now(),
      type: "node.heartbeat",
      nodeId: context.nodeId
    };
    this.eventListeners.emit(event);
  }

  private emitNodeLog(source: "stdout" | "stderr", line: string): void {
    const context = this.eventContext();
    const event: EventEnvelope = {
      id: context.makeId(),
      runId: context.runId,
      ts: context.now(),
      type: "node.log",
      nodeId: context.nodeId,
      source,
      line
    };
    this.eventListeners.emit(event);
  }

  private async ensureProcess(): Promise<void> {
    if (!this.process) {
      await this.spawnProcess();
    }
  }

  private shouldCloseAfterPrompt(): boolean {
    if (this.config.protocol === "raw") {
      return false;
    }
    if (this.config.protocol === "stream-json") {
      return !this.shouldUseStreamJsonInput();
    }
    const args = this.config.args ?? [];
    return args.includes("--print") && !this.config.resume;
  }

  private serializePrompt(input: ProviderTurnInput): string {
    if (this.config.protocol === "raw") {
      return input.prompt;
    }
    if (this.config.protocol === "stream-json") {
      return this.shouldUseStreamJsonInput()
        ? this.serializeStreamJsonInput(input)
        : input.prompt;
    }
    return JSON.stringify({
      kind: "prompt",
      prompt: input.prompt,
      promptKind: input.promptKind,
      turnId: input.turnId ?? null
    });
  }

  private shouldUseStreamJsonInput(): boolean {
    if (this.config.protocol !== "stream-json") {
      return false;
    }
    if (this.config.provider === "claude") {
      return true;
    }
    if (this.config.provider === "codex") {
      return true;
    }
    if (this.config.provider === "gemini") {
      const args = this.config.args ?? [];
      const inputFormat = this.getCliOptionValue(args, "--input-format");
      return inputFormat === "stream-json";
    }
    return false;
  }

  private serializeStreamJsonInput(input: ProviderTurnInput): string {
    if (this.config.provider === "gemini") {
      const payload: { type: "message"; role: "user"; content: string; turn_id?: string } = {
        type: "message",
        role: "user",
        content: input.prompt
      };
      if (input.turnId) {
        payload.turn_id = input.turnId;
      }
      return JSON.stringify(payload);
    }
    const payload = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: input.prompt
          }
        ]
      }
    };
    return JSON.stringify(payload);
  }

  private getCliOptionValue(args: string[], option: string): string | null {
    for (let i = 0; i < args.length; i += 1) {
      const value = args[i];
      if (value === option) {
        return args[i + 1] ?? null;
      }
      if (value.startsWith(`${option}=`)) {
        return value.slice(option.length + 1);
      }
    }
    return null;
  }

  private async sendApprovalResolution(
    approvalId: UUID,
    resolution: ApprovalResolution,
    source: "auto" | "ui"
  ): Promise<void> {
    if (this.resolvedApprovals.has(approvalId)) {
      return;
    }
    this.resolvedApprovals.add(approvalId);
    this.pendingApprovals.delete(approvalId);

    if (this.config.protocol !== "stream-json") {
      this.logger.error("approval resolution not supported for non-stream-json protocol", {
        nodeId: this.config.nodeId,
        protocol: this.config.protocol
      });
      return;
    }

    const payload = JSON.stringify({
      type: "approval.resolved",
      approvalId,
      resolution
    });
    await this.writeLine(payload);
    this.logger.info("approval resolved", {
      nodeId: this.config.nodeId,
      approvalId,
      source
    });

    const event = normalizeCliEvent(this.eventContext(), {
      type: "approval.resolved",
      approvalId,
      resolution
    });
    this.eventListeners.emit(event);
  }

  private async writeLine(line: string): Promise<void> {
    const processRef = this.process;
    if (!processRef || !processRef.stdin || !processRef.stdin.writable) {
      const error = new Error("provider process is not writable");
      this.errorListeners.emit(error);
      throw error;
    }
    const { stdin } = processRef;

    await new Promise<void>((resolve, reject) => {
      stdin.write(`${line}\n`, (err) => {
        if (err) {
          this.errorListeners.emit(err);
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private endInput(): void {
    const processRef = this.process;
    if (!processRef?.stdin || !processRef.stdin.writable) {
      return;
    }
    processRef.stdin.end();
  }

  private emitRawFinal(content: string): void {
    const event = normalizeCliEvent(this.eventContext(), {
      type: "message.assistant.final",
      content
    });
    this.eventListeners.emit(event);
    this.emitTurnStatus("turn.completed");
    this.stopHeartbeat();
  }

  private formatRawExitMessage(code: number | null, signal: NodeJS.Signals | null): string {
    const codeLabel = code === null ? "unknown" : String(code);
    const signalLabel = signal ? `, signal ${signal}` : "";
    return `Provider exited (code ${codeLabel}${signalLabel}) without output.`;
  }
}

export function createCliProviderAdapter(config: CliProviderConfig, logger?: Logger): CliProviderAdapter {
  return new CliProviderAdapter(config, logger);
}

export function resolvePermissionsMode(mode: CliPermissionsMode | undefined): CliPermissionsMode {
  return mode ?? "skip";
}
