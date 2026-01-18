import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  ApprovalResolution,
  CliPermissionsMode,
  EventEnvelope,
  NodePatchEvent,
  NodeState,
  TurnStatus,
  UUID
} from "@vuhlp/contracts";
import { parseCliEventLine, parseCliStreamEndLine, type ParsedCliEvent } from "./cli-protocol.js";
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: CliProviderConfig, logger: Logger = new ConsoleLogger()) {
    this.config = config;
    this.logger = logger;
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
    this.shouldCloseAfterTurn = !this.config.resume;
    this.awaitingTurn = true;
    this.sawTurnOutput = false;
    this.hadProcessError = false;
    this.streamBuffer = { content: "", thinking: "" };
    this.emitTurnStatus("turn.started");
    this.emitTurnStatus("waiting_for_model");
    this.startHeartbeat();
    const payload = this.serializePrompt(input);
    await this.writeLine(payload);
    if (this.shouldCloseAfterTurn) {
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
      resume: this.config.resume
    });

    const env = this.config.env ? { ...process.env, ...this.config.env } : process.env;
    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.process = child;
    this.emitConnectionPatch("connected");

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
      } else if (this.config.protocol === "stream-json" && this.awaitingTurn && !this.hadProcessError) {
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
    const parsed = usesStructuredOutput ? parseCliEventLine(line) : null;
    let handledStructured = false;

    if (parsed) {
      handledStructured = true;
      await this.handleParsedEvent(parsed);
    } else if (usesStructuredOutput && parseCliStreamEndLine(line)) {
      handledStructured = true;
      await this.handleStreamEnd();
    } else if (usesStructuredOutput) {
      if (looksLikeJson) {
        const excerpt = trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
        this.logger.debug("unrecognized structured event line", {
          nodeId: this.config.nodeId,
          line: excerpt
        });
      }
    }

    const shouldLog = source === "stderr" || this.config.protocol === "raw" || !handledStructured;
    if (shouldLog) {
      this.emitNodeLog(source, line);
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
    if (event.type === "message.assistant.delta") {
      this.appendStreamDelta("content", event.delta);
    }
    if (event.type === "message.assistant.thinking.delta") {
      this.appendStreamDelta("thinking", event.delta);
    }
    if (event.type === "message.assistant.final") {
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

    this.eventListeners.emit(normalizeCliEvent(this.eventContext(), event));

    if (event.type === "message.assistant.final") {
      await this.completeTurn();
    }
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
    const buffer = this.streamBuffer;
    if (buffer && (buffer.content.length > 0 || buffer.thinking.length > 0)) {
      if (buffer.thinking.length > 0) {
        const thinkingFinal = normalizeCliEvent(this.eventContext(), {
          type: "message.assistant.thinking.final",
          content: buffer.thinking
        });
        this.eventListeners.emit(thinkingFinal);
      }
      const finalEvent = normalizeCliEvent(this.eventContext(), {
        type: "message.assistant.final",
        content: buffer.content
      });
      this.eventListeners.emit(finalEvent);
    }
    this.streamBuffer = null;
    await this.completeTurn();
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

  private serializePrompt(input: ProviderTurnInput): string {
    if (this.config.protocol === "raw" || this.config.protocol === "stream-json") {
      return input.prompt;
    }
    return JSON.stringify({
      kind: "prompt",
      prompt: input.prompt,
      promptKind: input.promptKind,
      turnId: input.turnId ?? null
    });
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

    if (this.config.protocol !== "jsonl") {
      this.logger.error("approval resolution not supported for non-jsonl protocol", {
        nodeId: this.config.nodeId,
        protocol: this.config.protocol
      });
      return;
    }

    const payload = JSON.stringify({
      kind: "approval.resolved",
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
