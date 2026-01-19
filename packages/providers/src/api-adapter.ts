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

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  const base = value?.trim() || fallback;
  return base.replace(/\/+$/, "");
}

function parseJsonArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function streamSse(response: Response, onData: (data: string) => void): Promise<void> {
  const body = response.body;
  if (!body) {
    throw new Error("response body is empty");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (flushRemaining = false) => {
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = extractSseData(chunk);
      if (data !== null) {
        onData(data);
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (flushRemaining && buffer.trim().length > 0) {
      const data = extractSseData(buffer);
      if (data !== null) {
        onData(data);
      }
      buffer = "";
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    flush();
  }

  buffer += decoder.decode();
  flush(true);
}

function extractSseData(chunk: string): string | null {
  const lines = chunk.split("\n");
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return dataLines.join("\n");
}

async function streamJsonLines(response: Response, onLine: (line: string) => void): Promise<void> {
  const body = response.body;
  if (!body) {
    throw new Error("response body is empty");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (flushRemaining = false) => {
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n");
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (line.length > 0) {
        onLine(line);
      }
      boundary = buffer.indexOf("\n");
    }
    if (flushRemaining && buffer.trim().length > 0) {
      onLine(buffer.trim());
      buffer = "";
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    flush();
  }

  buffer += decoder.decode();
  flush(true);
}

type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type ClaudeMessage = {
  role: "user" | "assistant";
  content: ClaudeContentBlock[];
};

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
};

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
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
  private openAiHistory: OpenAIMessage[] = [];
  private claudeHistory: ClaudeMessage[] = [];
  private geminiHistory: GeminiContent[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private currentResponseId: UUID | null = null;
  private readonly debug = process.env.VUHLP_DEBUG_API === "true";

  constructor(config: ApiProviderConfig, logger: Logger = new ConsoleLogger()) {
    this.config = config;
    this.logger = logger;
    this.sessionId = randomUUID();
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
    this.appendUserPrompt(input.prompt);

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
      this.appendToolResult(toolToRun, result);
      await this.continueConversation();
      return;
    }

    const result = await this.runTool(toolToRun);
    this.appendToolResult(toolToRun, result);
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
    this.openAiHistory = [];
    this.claudeHistory = [];
    this.geminiHistory = [];
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
      this.appendToolResult(tool, result);
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

  private appendUserPrompt(prompt: string): void {
    switch (this.config.provider) {
      case "claude": {
        this.claudeHistory.push({ role: "user", content: [{ type: "text", text: prompt }] });
        break;
      }
      case "gemini": {
        this.geminiHistory.push({ role: "user", parts: [{ text: prompt }] });
        break;
      }
      case "codex":
      default: {
        this.openAiHistory.push({ role: "user", content: prompt });
        break;
      }
    }
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

  private appendToolResult(tool: ToolCall, result: ToolExecutionResult): void {
    const payload = {
      ok: result.ok,
      output: result.output,
      error: result.error
    };

    switch (this.config.provider) {
      case "claude": {
        this.claudeHistory.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: tool.id,
              content: JSON.stringify(payload),
              is_error: !result.ok
            }
          ]
        });
        break;
      }
      case "gemini": {
        this.geminiHistory.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: tool.name,
                response: payload
              }
            }
          ]
        });
        break;
      }
      case "codex":
      default: {
        this.openAiHistory.push({
          role: "tool",
          tool_call_id: tool.id,
          content: JSON.stringify(payload)
        });
        break;
      }
    }
  }

  private async callModel(): Promise<ModelResponse> {
    switch (this.config.provider) {
      case "claude":
        return this.callClaude();
      case "gemini":
        return this.callGemini();
      case "codex":
      default:
        return this.callOpenAI();
    }
  }

  private async callOpenAI(): Promise<ModelResponse> {
    const url = `${normalizeBaseUrl(this.config.apiBaseUrl, "https://api.openai.com/v1")}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: this.openAiHistory,
      tools: openAiToolDefinitions(),
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true }
    };
    if (this.config.maxTokens) {
      body.max_tokens = this.config.maxTokens;
    }

    this.debugLog(`OpenAI Request: POST ${url}`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey.slice(0, 8)}...`
      },
      body
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(body)
    });

    this.debugLog(`OpenAI Response: ${response.status} ${response.statusText}`, {
      headers: Object.fromEntries(response.headers.entries())
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI request failed (${response.status}): ${text}`);
    }

    const toolCallsByIndex = new Map<number, { id: string; name: string; argsText: string }>();
    let text = "";
    type OpenAIPayload = {
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
        };
        message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
      }>;
      usage?: OpenAIUsage;
    };

    let usagePromptTokens: number | null = null;
    let usageCompletionTokens: number | null = null;
    let usageTotalTokens: number | null = null;

    await streamJsonLines(response, (line) => {
      const data = line.startsWith("data:") ? line.slice(5).trimStart() : line;
      if (data === "[DONE]") {
        return;
      }
      const payload = safeJsonParse(data) as OpenAIPayload | null;
      if (!payload) {
        return;
      }
      if (payload.usage) {
        usagePromptTokens = payload.usage.prompt_tokens;
        usageCompletionTokens = payload.usage.completion_tokens;
        usageTotalTokens = payload.usage.total_tokens;
      }

      const delta = payload.choices?.[0]?.delta;
      if (!delta) {
        return;
      }
      if (typeof delta.content === "string") {
        text += delta.content;
        this.emitDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = typeof call.index === "number" ? call.index : toolCallsByIndex.size;
          const entry = toolCallsByIndex.get(index) ?? {
            id: call.id ?? randomUUID(),
            name: "",
            argsText: ""
          };
          if (call.id) {
            entry.id = call.id;
          }
          if (call.function?.name) {
            entry.name = call.function.name;
          }
          if (call.function?.arguments) {
            entry.argsText += call.function.arguments;
          }
          toolCallsByIndex.set(index, entry);
        }
      }
    });

    if (
      usagePromptTokens !== null &&
      usageCompletionTokens !== null &&
      usageTotalTokens !== null
    ) {
      this.emitEvent(
        normalizeCliEvent(this.eventContext(), {
          type: "telemetry.usage",
          provider: "codex",
          model: this.config.model,
          usage: {
            promptTokens: usagePromptTokens,
            completionTokens: usageCompletionTokens,
            totalTokens: usageTotalTokens
          }
        })
      );
    }

    const ordered = [...toolCallsByIndex.entries()].sort((a, b) => a[0] - b[0]);
    const toolCalls = ordered.map(([, call]) => ({
      id: call.id,
      name: call.name,
      args: parseJsonArgs(call.argsText)
    }));
    const openAiToolCalls: OpenAIToolCall[] = ordered.map(([, call]) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: call.argsText
      }
    }));

    this.openAiHistory.push({
      role: "assistant",
      content: text.length > 0 ? text : null,
      tool_calls: openAiToolCalls.length > 0 ? openAiToolCalls : undefined
    });

    return {
      text,
      toolCalls
    };
  }

  private async callClaude(): Promise<ModelResponse> {
    const url = `${normalizeBaseUrl(this.config.apiBaseUrl, "https://api.anthropic.com")}/v1/messages`;

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? 2048,
      messages: this.claudeHistory,
      tools: claudeToolDefinitions(),
      stream: true
    };

    this.debugLog(`Claude Request: POST ${url}`, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": `${this.config.apiKey.slice(0, 8)}...`,
        "anthropic-version": "2023-06-01"
      },
      body
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });

    this.debugLog(`Claude Response: ${response.status} ${response.statusText}`, {
      headers: Object.fromEntries(response.headers.entries())
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Claude request failed (${response.status}): ${text}`);
    }

    const blocks = new Map<
      number,
      { type: "text" | "thinking" | "tool_use"; id?: string; name?: string; inputJson: string; thinkingText?: string }
    >();
    let text = "";
    let thinkingText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    await streamSse(response, (data) => {
      const payload = safeJsonParse(data) as
        | {
          type?: string;
          index?: number;
          content_block?: { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> };
          delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        }
        | null;
      if (!payload?.type) {
        return;
      }
      switch (payload.type) {
        case "message_start": {
          if (payload.message?.usage) {
            inputTokens += payload.message.usage.input_tokens ?? 0;
          }
          break;
        }
        case "message_stop": {
          // Can contain total usage? No, typically message_delta has usage?
          // Actually, 'message_start' has 'usage' (input_tokens).
          // 'message_delta' has 'usage' (output_tokens).
          // Let's track them.
          break;
        }
        case "message_delta": {
          if (payload.usage) {
            outputTokens = payload.usage.output_tokens ?? outputTokens;
          }
          break;
        }
        case "content_block_start": {
          const index = typeof payload.index === "number" ? payload.index : blocks.size;
          const contentBlock = payload.content_block;
          if (contentBlock?.type === "text") {
            const initial = typeof contentBlock.text === "string" ? contentBlock.text : "";
            if (initial) {
              text += initial;
              this.emitDelta(initial);
            }
            blocks.set(index, { type: "text", inputJson: "" });
          } else if (contentBlock?.type === "thinking") {
            const initial = typeof contentBlock.thinking === "string" ? contentBlock.thinking : "";
            if (initial) {
              thinkingText += initial;
              this.emitThinkingDelta(initial);
            }
            blocks.set(index, { type: "thinking", inputJson: "", thinkingText: initial });
          } else if (contentBlock?.type === "tool_use") {
            const input = contentBlock.input ?? {};
            const inputJson = Object.keys(input).length > 0 ? JSON.stringify(input) : "";
            blocks.set(index, {
              type: "tool_use",
              id: contentBlock.id,
              name: contentBlock.name,
              inputJson
            });
          }
          break;
        }
        case "content_block_delta": {
          const index = typeof payload.index === "number" ? payload.index : -1;
          const delta = payload.delta;
          if (!delta) {
            break;
          }
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            text += delta.text;
            this.emitDelta(delta.text);
          }
          if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            thinkingText += delta.thinking;
            this.emitThinkingDelta(delta.thinking);
            const entry = blocks.get(index);
            if (entry && entry.type === "thinking") {
              entry.thinkingText = (entry.thinkingText ?? "") + delta.thinking;
            }
          }
          if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const entry = blocks.get(index);
            if (entry) {
              const trimmed = entry.inputJson.trim();
              if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
                entry.inputJson = "";
              }
              entry.inputJson += delta.partial_json;
            } else {
              blocks.set(index, { type: "tool_use", inputJson: delta.partial_json });
            }
          }
          break;
        }
        default:
          break;
      }
    });

    // Emit thinking.final if we accumulated thinking content
    if (thinkingText.length > 0) {
      this.emitThinkingFinal(thinkingText);
    }

    if (inputTokens > 0 || outputTokens > 0) {
      this.emitEvent(
        normalizeCliEvent(this.eventContext(), {
          type: "telemetry.usage",
          provider: "claude",
          model: this.config.model,
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: inputTokens + outputTokens
          }
        })
      );
    }


    const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]);
    const toolCalls = ordered
      .filter(([, block]) => block.type === "tool_use")
      .map(([, block]) => ({
        id: block.id ?? randomUUID(),
        name: block.name ?? "tool",
        args: parseJsonArgs(block.inputJson)
      }));

    const assistantBlocks: ClaudeContentBlock[] = [];
    // Add thinking block first (Claude expects thinking before text)
    if (thinkingText.length > 0) {
      assistantBlocks.push({ type: "thinking", thinking: thinkingText });
    }
    if (text.length > 0) {
      assistantBlocks.push({ type: "text", text });
    }
    for (const toolCall of toolCalls) {
      assistantBlocks.push({ type: "tool_use", id: toolCall.id, name: toolCall.name, input: toolCall.args });
    }

    this.claudeHistory.push({ role: "assistant", content: assistantBlocks });

    return { text, toolCalls };
  }

  private async callGemini(): Promise<ModelResponse> {
    const base = normalizeBaseUrl(this.config.apiBaseUrl, "https://generativelanguage.googleapis.com/v1beta");
    const url = `${base}/models/${this.config.model}:streamGenerateContent?key=${encodeURIComponent(
      this.config.apiKey
    )}`;

    const body: Record<string, unknown> = {
      contents: this.geminiHistory,
      tools: [
        {
          functionDeclarations: geminiToolDefinitions()
        }
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: "AUTO"
        }
      }
    };

    if (this.config.maxTokens) {
      body.generationConfig = {
        maxOutputTokens: this.config.maxTokens
      };
    }

    this.debugLog(`Gemini Request: POST ${url.replace(this.config.apiKey, "KEY_HIDDEN")}`, {
      headers: {
        "Content-Type": "application/json"
      },
      body
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    this.debugLog(`Gemini Response: ${response.status} ${response.statusText}`, {
      headers: Object.fromEntries(response.headers.entries())
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini request failed (${response.status}): ${text}`);
    }

    const parts: GeminiPart[] = [];
    const toolCalls: ToolCall[] = [];
    let text = "";
    let usageMetadata: GeminiUsageMetadata | null = null;

    const allStreamedData: string[] = [];
    await streamSse(response, (data) => {
      allStreamedData.push(data);
      if (data === "[DONE]") {
        return;
      }
      const payload = safeJsonParse(data) as
        | {
          candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
          usageMetadata?: GeminiUsageMetadata;
        }
        | null;
      if (!payload) {
        return;
      }
      if (payload.usageMetadata) {
        usageMetadata = payload.usageMetadata;
      }
      const candidateParts = payload.candidates?.[0]?.content?.parts ?? [];
      for (const part of candidateParts) {
        if ("text" in part && typeof part.text === "string") {
          text += part.text;
          this.emitDelta(part.text);
          const last = parts[parts.length - 1];
          if (last && "text" in last) {
            last.text += part.text;
          } else {
            parts.push({ text: part.text });
          }
        } else if ("functionCall" in part) {
          const call = (part as Extract<GeminiPart, { functionCall: { name: string; args: Record<string, unknown> } }>).
            functionCall;
          const args = typeof call.args === "object" && call.args ? call.args : { _raw: call.args };
          toolCalls.push({
            id: randomUUID(),
            name: call.name,
            args
          });
          parts.push({ functionCall: { name: call.name, args } });
        }
      }
    });

    this.geminiHistory.push({ role: "model", parts });

    const usage = usageMetadata as GeminiUsageMetadata | null;
    if (usage) {
      const promptTokens =
        usage.promptTokenCount ??
        (usage.totalTokenCount !== undefined && usage.candidatesTokenCount !== undefined
          ? Math.max(usage.totalTokenCount - usage.candidatesTokenCount, 0)
          : 0);
      const completionTokens =
        usage.candidatesTokenCount ??
        (usage.totalTokenCount !== undefined
          ? Math.max(usage.totalTokenCount - promptTokens, 0)
          : 0);
      const totalTokens = usage.totalTokenCount ?? promptTokens + completionTokens;
      if (promptTokens > 0 || completionTokens > 0 || totalTokens > 0) {
        this.emitEvent(
          normalizeCliEvent(this.eventContext(), {
            type: "telemetry.usage",
            provider: "gemini",
            model: this.config.model,
            usage: {
              promptTokens,
              completionTokens,
              totalTokens
            }
          })
        );
      }
    }

    return { text, toolCalls };
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


function openAiToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "command",
        description: "Run a shell command in the repository.",
        parameters: {
          type: "object",
          properties: {
            cmd: { type: "string", description: "Shell command to run." },
            cwd: { type: "string", description: "Optional working directory." }
          },
          required: ["cmd"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from the repository.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to repo root." }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a file in the repository.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to repo root." },
            content: { type: "string", description: "File contents." }
          },
          required: ["path", "content"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files in a directory.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path relative to repo root." }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "delete_file",
        description: "Delete a file from the repository.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to repo root." }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "spawn_node",
        description: "Create a new node in the current run for delegation.",
        parameters: {
          type: "object",
          properties: {
            label: { type: "string", description: "Node display label." },
            alias: { type: "string", description: "Optional stable alias for the node." },
            roleTemplate: { type: "string", description: "Role template name for the new node." },
            role: { type: "string", description: "Alias for roleTemplate." },
            provider: { type: "string", description: "Provider to use for the new node." },
            customSystemPrompt: { type: "string", description: "Optional custom system prompt override." },
            capabilities: {
              type: "object",
              properties: {
                spawnNodes: { type: "boolean" },
                writeCode: { type: "boolean" },
                writeDocs: { type: "boolean" },
                runCommands: { type: "boolean" },
                delegateOnly: { type: "boolean" }
              }
            },
            permissions: {
              type: "object",
              properties: {
                cliPermissionsMode: { type: "string" },
                agentManagementRequiresApproval: { type: "boolean" }
              }
            },
            session: {
              type: "object",
              properties: {
                resume: { type: "boolean" },
                resetCommands: { type: "array", items: { type: "string" } }
              }
            },
            instructions: { type: "string", description: "Initial task instructions for the node." },
            input: { type: "object", description: "Structured input payload for the node." }
          },
          required: ["label", "roleTemplate"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "create_edge",
        description: "Create an edge between two nodes in the current run.",
        parameters: {
          type: "object",
          properties: {
            from: { type: "string", description: "Source node id or alias." },
            to: { type: "string", description: "Target node id or alias." },
            bidirectional: { type: "boolean", description: "Whether the edge is bidirectional." },
            type: { type: "string", description: "Edge type (handoff or report)." },
            label: { type: "string", description: "Edge label." }
          },
          required: ["from", "to"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "send_handoff",
        description: "Send a handoff envelope to another node.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "Target node id or alias." },
            message: { type: "string", description: "Summary message for the handoff." },
            structured: { type: "object", description: "Structured JSON payload." },
            artifacts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  ref: { type: "string" }
                },
                required: ["type", "ref"]
              }
            },
            status: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                reason: { type: "string" }
              },
              required: ["ok"]
            },
            response: {
              type: "object",
              properties: {
                expectation: { type: "string", enum: ["none", "optional", "required"] },
                replyTo: { type: "string", description: "Node id or alias to reply to." }
              },
              required: ["expectation"]
            },
            contextRef: { type: "string", description: "Context pack reference." }
          },
          required: ["to", "message"]
        }
      }
    }
  ];
}

function claudeToolDefinitions() {
  return [
    {
      name: "command",
      description: "Run a shell command in the repository.",
      input_schema: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "Shell command to run." },
          cwd: { type: "string", description: "Optional working directory." }
        },
        required: ["cmd"]
      }
    },
    {
      name: "read_file",
      description: "Read a file from the repository.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to repo root." }
        },
        required: ["path"]
      }
    },
    {
      name: "write_file",
      description: "Write a file in the repository.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to repo root." },
          content: { type: "string", description: "File contents." }
        },
        required: ["path", "content"]
      }
    },
    {
      name: "list_files",
      description: "List files in a directory.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to repo root." }
        }
      }
    },
    {
      name: "delete_file",
      description: "Delete a file from the repository.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to repo root." }
        },
        required: ["path"]
      }
    },
    {
      name: "spawn_node",
      description: "Create a new node in the current run for delegation.",
      input_schema: {
        type: "object",
        properties: {
          label: { type: "string", description: "Node display label." },
          alias: { type: "string", description: "Optional stable alias for the node." },
          roleTemplate: { type: "string", description: "Role template name for the new node." },
          role: { type: "string", description: "Alias for roleTemplate." },
          provider: { type: "string", description: "Provider to use for the new node." },
          customSystemPrompt: { type: "string", description: "Optional custom system prompt override." },
          capabilities: {
            type: "object",
            properties: {
              spawnNodes: { type: "boolean" },
              writeCode: { type: "boolean" },
              writeDocs: { type: "boolean" },
              runCommands: { type: "boolean" },
              delegateOnly: { type: "boolean" }
            }
          },
          permissions: {
            type: "object",
            properties: {
              cliPermissionsMode: { type: "string" },
              agentManagementRequiresApproval: { type: "boolean" }
            }
          },
          session: {
            type: "object",
            properties: {
              resume: { type: "boolean" },
              resetCommands: { type: "array", items: { type: "string" } }
            }
          },
          instructions: { type: "string", description: "Initial task instructions for the node." },
          input: { type: "object", description: "Structured input payload for the node." }
        },
        required: ["label", "roleTemplate"]
      }
    },
    {
      name: "create_edge",
      description: "Create an edge between two nodes in the current run.",
      input_schema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Source node id or alias." },
          to: { type: "string", description: "Target node id or alias." },
          bidirectional: { type: "boolean", description: "Whether the edge is bidirectional." },
          type: { type: "string", description: "Edge type (handoff or report)." },
          label: { type: "string", description: "Edge label." }
        },
        required: ["from", "to"]
      }
    },
    {
      name: "send_handoff",
      description: "Send a handoff envelope to another node.",
      input_schema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target node id or alias." },
          message: { type: "string", description: "Summary message for the handoff." },
          structured: { type: "object", description: "Structured JSON payload." },
          artifacts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                ref: { type: "string" }
              },
              required: ["type", "ref"]
            }
          },
          status: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              reason: { type: "string" }
            },
            required: ["ok"]
          },
          response: {
            type: "object",
            properties: {
              expectation: { type: "string", enum: ["none", "optional", "required"] },
              replyTo: { type: "string", description: "Node id or alias to reply to." }
            },
            required: ["expectation"]
          },
          contextRef: { type: "string", description: "Context pack reference." }
        },
        required: ["to", "message"]
      }
    }
  ];
}

function geminiToolDefinitions() {
  return [
    {
      name: "command",
      description: "Run a shell command in the repository.",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "Shell command to run." },
          cwd: { type: "string", description: "Optional working directory." }
        },
        required: ["cmd"]
      }
    },
    {
      name: "read_file",
      description: "Read a file from the repository.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to repo root." }
        },
        required: ["path"]
      }
    },
    {
      name: "write_file",
      description: "Write a file in the repository.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to repo root." },
          content: { type: "string", description: "File contents." }
        },
        required: ["path", "content"]
      }
    },
    {
      name: "list_files",
      description: "List files in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to repo root." }
        }
      }
    },
    {
      name: "delete_file",
      description: "Delete a file from the repository.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to repo root." }
        },
        required: ["path"]
      }
    },
    {
      name: "spawn_node",
      description: "Create a new node in the current run for delegation.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Node display label." },
          alias: { type: "string", description: "Optional stable alias for the node." },
          roleTemplate: { type: "string", description: "Role template name for the new node." },
          role: { type: "string", description: "Alias for roleTemplate." },
          provider: { type: "string", description: "Provider to use for the new node." },
          customSystemPrompt: { type: "string", description: "Optional custom system prompt override." },
          capabilities: {
            type: "object",
            properties: {
              spawnNodes: { type: "boolean" },
              writeCode: { type: "boolean" },
              writeDocs: { type: "boolean" },
              runCommands: { type: "boolean" },
              delegateOnly: { type: "boolean" }
            }
          },
          permissions: {
            type: "object",
            properties: {
              cliPermissionsMode: { type: "string" },
              agentManagementRequiresApproval: { type: "boolean" }
            }
          },
          session: {
            type: "object",
            properties: {
              resume: { type: "boolean" },
              resetCommands: { type: "array", items: { type: "string" } }
            }
          },
          instructions: { type: "string", description: "Initial task instructions for the node." },
          input: { type: "object", description: "Structured input payload for the node." }
        },
        required: ["label", "roleTemplate"]
      }
    },
    {
      name: "create_edge",
      description: "Create an edge between two nodes in the current run.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Source node id or alias." },
          to: { type: "string", description: "Target node id or alias." },
          bidirectional: { type: "boolean", description: "Whether the edge is bidirectional." },
          type: { type: "string", description: "Edge type (handoff or report)." },
          label: { type: "string", description: "Edge label." }
        },
        required: ["from", "to"]
      }
    },
    {
      name: "send_handoff",
      description: "Send a handoff envelope to another node.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target node id or alias." },
          message: { type: "string", description: "Summary message for the handoff." },
          structured: { type: "object", description: "Structured JSON payload." },
          artifacts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                ref: { type: "string" }
              },
              required: ["type", "ref"]
            }
          },
          status: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              reason: { type: "string" }
            },
            required: ["ok"]
          },
          response: {
            type: "object",
            properties: {
              expectation: { type: "string", enum: ["none", "optional", "required"] },
              replyTo: { type: "string", description: "Node id or alias to reply to." }
            },
            required: ["expectation"]
          },
          contextRef: { type: "string", description: "Context pack reference." }
        },
        required: ["to", "message"]
      }
    }
  ];
}
