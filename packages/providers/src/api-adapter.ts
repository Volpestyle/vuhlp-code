
import { randomUUID } from "node:crypto";
import type {
  ApprovalResolution,
  NodePatchEvent,
  TurnStatus,
  ToolCall,
  UUID
} from "@vuhlp/contracts";
import { normalizeCliEvent, type EventContext } from "./normalize.js";
import { ConsoleLogger, type Logger, type LogMeta } from "./logger.js";
import type {
  ApiProviderConfig,
  ProviderAdapter,
  ProviderErrorListener,
  ProviderEventListener,
  ProviderTurnInput
} from "./types.js";
import { executeToolCall, type ToolExecutionResult } from "./tool-runner.js";
import type { ModelProvider, ModelResponse, TokenUsage } from "./providers/base.js";
import { ClaudeProvider } from "./providers/claude.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OpenAIProvider } from "./providers/openai.js";

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

export class ApiProviderAdapter implements ProviderAdapter {
  private readonly config: ApiProviderConfig;
  private readonly logger: Logger;
  private readonly eventListeners = createListenerSet<ReturnType<typeof normalizeCliEvent>>();
  private readonly errorListeners = createListenerSet<Error>();
  private sessionId: string;
  private activeTurn = false;
  private pendingApproval: {
    approvalId: UUID;
    tool: ToolCall;
  } | null = null;
  private toolQueue: ToolCall[] = [];
  private processing = false;

  private provider: ModelProvider;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private currentResponseId: UUID | null = null;
  private readonly debug = process.env.VUHLP_DEBUG_API === "true";

  constructor(config: ApiProviderConfig, logger: Logger = new ConsoleLogger()) {
    this.config = config;
    this.logger = logger;
    this.sessionId = randomUUID();

    switch (config.provider) {
      case "claude":
        this.provider = new ClaudeProvider(config);
        break;
      case "gemini":
        this.provider = new GeminiProvider(config);
        break;
      case "codex":
      default:
        this.provider = new OpenAIProvider(config);
        break;
    }
  }

  private debugLog(message: string, meta?: LogMeta): void {
    if (this.debug) {
      this.logger.debug(message, meta);
    }
  }

  onEvent(listener: ProviderEventListener): () => void {
    return this.eventListeners.add(listener);
  }

  onError(listener: ProviderErrorListener): () => void {
    return this.errorListeners.add(listener);
  }

  async start(): Promise<void> {
    this.emitConnectionPatch("connected");
  }

  async send(input: ProviderTurnInput): Promise<void> {
    if (this.activeTurn) {
      const error = new Error("provider adapter already running a turn");
      this.errorListeners.emit(error);
      throw error;
    }

    this.activeTurn = true;
    this.currentResponseId = randomUUID();
    this.toolQueue = [];
    this.pendingApproval = null;
    this.emitTurnStatus("turn.started");
    this.startHeartbeat();
    if (input.promptKind === "full") {
      this.resetHistory();
    }
    this.provider.appendUserPrompt(input.prompt);

    void this.continueConversation().catch((error) => {
      const message = error instanceof Error ? error : new Error(String(error));
      this.errorListeners.emit(message);
      this.activeTurn = false;
      this.emitTurnStatus("turn.failed", message.message);
      this.stopHeartbeat();
    });
  }

  async interrupt(): Promise<void> {
    if (!this.activeTurn) {
      return;
    }
    this.activeTurn = false;
    this.toolQueue = [];
    this.pendingApproval = null;
    this.emitTurnStatus("turn.interrupted");
    this.stopHeartbeat();
  }

  async resolveApproval(approvalId: UUID, resolution: ApprovalResolution): Promise<void> {
    if (!this.pendingApproval || this.pendingApproval.approvalId !== approvalId) {
      this.logger.warn("approval resolution without pending request", { approvalId });
      return;
    }

    const { tool } = this.pendingApproval;
    this.pendingApproval = null;

    let toolToRun = tool;
    if (resolution.status === "modified" && resolution.modifiedArgs) {
      toolToRun = { ...tool, args: resolution.modifiedArgs };
    }

    if (resolution.status === "denied") {
      const result = { ok: false, output: "", error: "Tool denied by user" };
      this.emitEvent(
        normalizeCliEvent(this.eventContext(), {
          type: "tool.completed",
          toolId: toolToRun.id,
          result: { ok: false },
          error: { message: result.error ?? "Tool denied by user" }
        })
      );
      this.provider.appendToolResult(toolToRun, result);
      await this.continueConversation();
      return;
    }

    const result = await this.runTool(toolToRun);
    this.provider.appendToolResult(toolToRun, result);
    await this.continueConversation();
  }

  async resetSession(): Promise<void> {
    this.sessionId = randomUUID();
    this.resetHistory();
  }

  async close(): Promise<void> {
    this.emitConnectionPatch("disconnected");
    this.stopHeartbeat();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  private resetHistory(): void {
    this.provider.resetHistory();
    this.toolQueue = [];
    this.pendingApproval = null;
  }

  private async continueConversation(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      while (this.activeTurn && !this.pendingApproval) {
        if (this.toolQueue.length > 0) {
          const blocked = await this.processToolQueue();
          if (blocked) {
            return;
          }
          continue;
        }

        this.emitTurnStatus("waiting_for_model");
        const response = await this.callModel();
        if (!this.activeTurn) {
          return;
        }
        if (response.toolCalls.length === 0) {
          this.emitEvent(
            normalizeCliEvent(this.eventContext(), {
              type: "message.assistant.final",
              content: response.text,
              id: this.currentResponseId ?? undefined
            })
          );
          this.emitTurnStatus("turn.completed");
          this.stopHeartbeat();
          this.toolQueue = [];
          this.activeTurn = false;
          return;
        }

        this.toolQueue = [...response.toolCalls];
      }
    } finally {
      this.processing = false;
    }
  }

  private async processToolQueue(): Promise<boolean> {
    while (this.toolQueue.length > 0) {
      const tool = this.toolQueue.shift();
      if (!tool) {
        break;
      }
      this.emitTurnStatus("tool.pending", `tool pending: ${tool.name}`);
      this.emitEvent(normalizeCliEvent(this.eventContext(), { type: "tool.proposed", tool }));

      const requiresApproval =
        this.config.permissionsMode === "gated" ||
        (this.config.agentManagementRequiresApproval === true &&
          (tool.name === "spawn_node" || tool.name === "create_edge"));
      if (requiresApproval) {
        const approvalId = tool.id ?? randomUUID();
        this.pendingApproval = { approvalId, tool };
        this.emitTurnStatus("awaiting_approval", `awaiting approval: ${tool.name}`);
        this.emitEvent(
          normalizeCliEvent(this.eventContext(), {
            type: "approval.requested",
            approvalId,
            tool,
            context: this.buildApprovalContext(tool)
          })
        );
        return true;
      }

      const result = await this.runTool(tool);
      this.provider.appendToolResult(tool, result);
    }
    return false;
  }

  private async runTool(tool: ToolCall): Promise<ToolExecutionResult> {
    this.emitEvent(normalizeCliEvent(this.eventContext(), { type: "tool.started", tool }));
    const result = await executeToolCall(tool, {
      cwd: this.config.cwd ?? process.cwd(),
      capabilities: this.config.capabilities,
      globalMode: this.config.globalMode,
      defaultProvider: this.config.provider,
      spawnNode: this.config.spawnNode,
      createEdge: this.config.createEdge,
      sendHandoff: this.config.sendHandoff,
      logger: this.logger
    });
    this.emitEvent(
      normalizeCliEvent(this.eventContext(), {
        type: "tool.completed",
        toolId: tool.id,
        result: { ok: result.ok },
        error: result.ok ? undefined : { message: result.error ?? "tool failed" }
      })
    );
    return result;
  }

  private buildApprovalContext(tool: ToolCall): string | undefined {
    const args = tool.args ?? {};
    if (tool.name === "spawn_node") {
      const label = typeof args.label === "string" ? args.label : "unnamed";
      const role =
        typeof args.roleTemplate === "string"
          ? args.roleTemplate
          : typeof args.role === "string"
            ? args.role
            : "unknown";
      return `Spawn node: ${label} (${role})`;
    }
    if (tool.name === "create_edge") {
      const from = typeof args.from === "string" ? args.from : "unknown";
      const to = typeof args.to === "string" ? args.to : "unknown";
      const type = typeof args.type === "string" ? args.type : "handoff";
      return `Create edge: ${from} -> ${to} (${type})`;
    }
    if (tool.name === "send_handoff") {
      const to = typeof args.to === "string" ? args.to : "unknown";
      return `Send handoff to: ${to}`;
    }
    return undefined;
  }

  private async callModel(): Promise<ModelResponse> {
    return this.provider.call({
      onDelta: (delta: string) => this.emitDelta(delta),
      onThinkingDelta: (delta: string) => this.emitThinkingDelta(delta),
      onThinkingFinal: (content: string) => this.emitThinkingFinal(content),
      onUsage: (usage: TokenUsage) => this.emitUsage(usage),
      debugLog: (message: string, meta?: LogMeta) => this.debugLog(message, meta)
    });
  }

  private emitDelta(delta: string): void {
    if (!delta) {
      return;
    }
    this.emitEvent(
      normalizeCliEvent(this.eventContext(), {
        type: "message.assistant.delta",
        delta
      })
    );
  }

  private emitThinkingDelta(delta: string): void {
    if (!delta) {
      return;
    }
    this.emitEvent(
      normalizeCliEvent(this.eventContext(), {
        type: "message.assistant.thinking.delta",
        delta
      })
    );
  }

  private emitThinkingFinal(content: string): void {
    if (!content) {
      return;
    }
    this.emitEvent(
      normalizeCliEvent(this.eventContext(), {
        type: "message.assistant.thinking.final",
        content
      })
    );
  }

  private emitUsage(usage: TokenUsage): void {
    this.emitEvent(
      normalizeCliEvent(this.eventContext(), {
        type: "telemetry.usage",
        provider: this.config.provider, // Correctly use provider from config
        model: this.config.model,
        usage
      })
    );
  }

  private emitEvent(event: ReturnType<typeof normalizeCliEvent>): void {
    this.eventListeners.emit(event);
  }

  private eventContext(): EventContext {
    return {
      runId: this.config.runId,
      nodeId: this.config.nodeId,
      now: nowIso,
      makeId: randomUUID
    };
  }

  private emitConnectionPatch(status: "connected" | "idle" | "disconnected"): void {
    const event: NodePatchEvent = {
      id: randomUUID(),
      runId: this.config.runId,
      ts: nowIso(),
      type: "node.patch",
      nodeId: this.config.nodeId,
      patch: {
        connection: {
          status,
          streaming: status === "connected",
          lastHeartbeatAt: nowIso(),
          lastOutputAt: nowIso()
        }
      }
    };
    this.eventListeners.emit(event);
  }

  private emitTurnStatus(status: TurnStatus, detail?: string): void {
    const context = this.eventContext();
    this.eventListeners.emit({
      id: context.makeId(),
      runId: context.runId,
      ts: context.now(),
      type: "turn.status",
      nodeId: context.nodeId,
      status,
      detail
    });
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
    this.eventListeners.emit({
      id: context.makeId(),
      runId: context.runId,
      ts: context.now(),
      type: "node.heartbeat",
      nodeId: context.nodeId
    });
  }
}
