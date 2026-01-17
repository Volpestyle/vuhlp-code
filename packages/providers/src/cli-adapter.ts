import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  ApprovalResolution,
  CliPermissionsMode,
  EventEnvelope,
  NodePatchEvent,
  NodeState,
  UUID
} from "@vuhlp/contracts";
import { parseCliEventLine, type ParsedCliEvent } from "./cli-protocol.js";
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
    const payload = this.serializePrompt(input);
    await this.writeLine(payload);
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
    this.emitConnectionPatch("disconnected");
  }

  getSessionId(): string | null {
    return this.process?.pid ? String(this.process.pid) : null;
  }

  private async spawnProcess(): Promise<void> {
    this.logger.info("starting provider process", {
      nodeId: this.config.nodeId,
      provider: this.config.provider,
      command: this.config.command
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
      this.logger.error("provider process error", { nodeId: this.config.nodeId, message: error.message });
      this.errorListeners.emit(error);
      this.emitConnectionPatch("disconnected");
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.logger.warn("provider process exited", {
        nodeId: this.config.nodeId,
        code: code ?? null,
        signal: signal ?? null
      });
      this.emitConnectionPatch("disconnected");
    });

    const stdout = child.stdout;
    if (stdout) {
      const reader = createInterface({ input: stdout });
      reader.on("line", (line) => {
        void this.handleLine(line, "stdout");
      });
    }

    const stderr = child.stderr;
    if (stderr) {
      const reader = createInterface({ input: stderr });
      reader.on("line", (line) => {
        void this.handleLine(line, "stderr");
      });
    }
  }

  private async handleLine(line: string, source: "stdout" | "stderr"): Promise<void> {
    if (this.config.protocol === "jsonl") {
      const parsed = parseCliEventLine(line);
      if (parsed) {
        await this.handleParsedEvent(parsed);
        return;
      }
      const trimmed = line.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        const excerpt = trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
        this.logger.debug("unrecognized jsonl event line", {
          nodeId: this.config.nodeId,
          line: excerpt
        });
      }
    }

    const delta = source === "stderr" ? `stderr: ${line}` : line;
    const event = normalizeCliEvent(this.eventContext(), {
      type: "message.assistant.delta",
      delta: `${delta}\n`
    });
    this.eventListeners.emit(event);
  }

  private async handleParsedEvent(event: ParsedCliEvent): Promise<void> {

    if (event.type === "approval.requested") {
      this.pendingApprovals.add(event.approvalId);
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

    this.eventListeners.emit(normalizeCliEvent(this.eventContext(), event));

    if (event.type === "message.assistant.final") {
      if (this.shouldCloseAfterTurn) {
        await this.close();
      }
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

  private async ensureProcess(): Promise<void> {
    if (!this.process) {
      await this.spawnProcess();
    }
  }

  private serializePrompt(input: ProviderTurnInput): string {
    if (this.config.protocol === "raw") {
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
      this.logger.error("approval resolution not supported for raw protocol", { nodeId: this.config.nodeId });
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
}

export function createCliProviderAdapter(config: CliProviderConfig, logger?: Logger): CliProviderAdapter {
  return new CliProviderAdapter(config, logger);
}

export function resolvePermissionsMode(mode: CliPermissionsMode | undefined): CliPermissionsMode {
  return mode ?? "skip";
}
