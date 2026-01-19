import type {
  ApprovalRequest,
  ApprovalResolution,
  EventEnvelope,
  NodeState,
  PromptArtifacts,
  ProviderName,
  ToolCall,
  UserMessageRecord,
  UUID
} from "@vuhlp/contracts";
import {
  ConsoleLogger,
  createProviderAdapter,
  executeToolCall,
  resolvePermissionsMode,
  type ApiProviderConfig,
  type CliProviderConfig,
  type CreateEdgeRequest,
  type CreateEdgeResult,
  type Logger,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderProtocol,
  type SendHandoffRequest,
  type SendHandoffResult,
  type SpawnNodeRequest,
  type SpawnNodeResult,
  type ToolExecutionResult
} from "@vuhlp/providers";
import { AsyncQueue } from "./async-queue.js";
import { PromptBuilder } from "./prompt-builder.js";
import type { NodeRunner, TurnInput, TurnResult } from "./runner.js";
import { hashString, newId, nowIso } from "./utils.js";

interface ProviderSpec {
  transport: "cli" | "api";
  command?: string;
  args?: string[];
  protocol?: ProviderProtocol;
  statefulStreaming?: boolean;
  resumeArgs?: string[];
  replayTurns?: number;
  apiKey?: string;
  apiBaseUrl?: string;
  model?: string;
  maxTokens?: number;
}

interface PendingTurn {
  promptArtifacts: PromptArtifacts;
  partialOutput: string;
  promptLogged: boolean;
  inputMessages: UserMessageRecord[];
  toolQueue?: ToolCall[];
  toolMessage?: string;
  toolErrors?: string[];
  toolProposed?: boolean;
}

interface ProviderSession {
  adapter: ProviderAdapter;
  queue: AsyncQueue<TurnSignal>;
  config: ProviderConfig;
  promptSent: boolean;
  lastPromptHeaderHash?: string;
  pendingTurn?: PendingTurn;
  activeTurn?: PendingTurn;
  sessionId?: string;
  interrupted?: boolean;
  completedTurns: number;
  baseArgs?: string[];
  resumeArgs?: string[];
  replayTurns: number;
  transcript: UserMessageRecord[];
  statelessProtocol: boolean;
}

type TurnSignal =
  | { type: "message.assistant.delta"; delta: string }
  | { type: "message.assistant.final"; content: string; toolCalls?: ToolCall[] }
  | { type: "interrupted" }
  | { type: "approval.requested"; approval: ApprovalRequest }
  | { type: "error"; error: Error };

const CLI_TOOL_PROTOCOL = [
  "Tool calls:",
  "Use native tool calling when available (Claude CLI: Task for spawning, Bash for shell commands).",
  "vuhlp maps native tools to vuhlp tools (Task -> spawn_node, Bash -> command).",
  "If a tool is not available natively, emit a single-line JSON object in your response:",
  "{\"tool_call\":{\"id\":\"tool-1\",\"name\":\"<tool>\",\"args\":{...}}}",
  "Do not wrap the JSON in markdown. One tool call per line.",
  "Tool_call JSON must be the entire line with no extra text.",
  "Use args (not params) for tool_call JSON.",
  "Tool_call id can be any short unique string or omitted (vuhlp will generate one). Do not call Bash to generate ids.",
  "Do not use Bash to emit tool_call JSON or simulate tool calls.",
  "Bash output containing tool_call JSON is treated as an error.",
  "Only use spawn_node/create_edge (Task) when Task Payload shows spawnNodes=true.",
  "Use spawn_node alias to reference freshly spawned nodes in the same response.",
  "Aliases must be unique within the run.",
  "Tool schemas (tool_call args):",
  "command: { cmd: string, cwd?: string }",
  "read_file: { path: string }",
  "write_file: { path: string, content: string }",
  "list_files: { path?: string }",
  "delete_file: { path: string }",
  "spawn_node: { label: string, alias?: string, roleTemplate: string, instructions?: string, input?: object, provider?: string, capabilities?: object, permissions?: object, session?: object, customSystemPrompt?: string }",
  "create_edge: { from: string, to: string, bidirectional?: boolean, type?: \"handoff\" | \"report\", label?: string } (from/to = node id or alias)",
  "send_handoff: { to: string, message: string, structured?: object, artifacts?: [{type: string, ref: string}], status?: {ok: boolean, reason?: string}, response?: {expectation: \"none\" | \"optional\" | \"required\", replyTo?: string}, contextRef?: string } (to/replyTo = node id or alias)",
  "Examples (emit exactly as a single line when calling):",
  "{\"tool_call\":{\"id\":\"<uuid>\",\"name\":\"spawn_node\",\"args\":{\"label\":\"Docs Agent\",\"alias\":\"docs-agent\",\"roleTemplate\":\"planner\",\"instructions\":\"Summarize docs/.\",\"provider\":\"claude\"}}}",
  "{\"tool_call\":{\"id\":\"<uuid>\",\"name\":\"create_edge\",\"args\":{\"from\":\"<node-id-or-alias>\",\"to\":\"<node-id-or-alias>\",\"type\":\"handoff\",\"bidirectional\":true,\"label\":\"docs\"}}}",
  "{\"tool_call\":{\"id\":\"<uuid>\",\"name\":\"send_handoff\",\"args\":{\"to\":\"<node-id-or-alias>\",\"message\":\"Status update\"}}}",
  "Available vuhlp tools: command, read_file, write_file, list_files, delete_file, spawn_node, create_edge, send_handoff.",
  "Outgoing handoffs are explicit; use send_handoff to communicate between nodes.",
  "create_edge only connects nodes; it does not deliver messages.",
  "send_handoff requires to + message and an existing edge between nodes; optional structured, artifacts, status, response, contextRef."
].join("\n");

export interface CliRunnerOptions {
  repoRoot: string;
  emitEvent: (runId: UUID, event: EventEnvelope) => void;
  logger?: Logger;
  spawnNode?: (runId: UUID, fromNodeId: UUID, request: SpawnNodeRequest) => Promise<SpawnNodeResult>;
  createEdge?: (runId: UUID, fromNodeId: UUID, request: CreateEdgeRequest) => Promise<CreateEdgeResult>;
  sendHandoff?: (runId: UUID, fromNodeId: UUID, request: SendHandoffRequest) => Promise<SendHandoffResult>;
  systemTemplatesDir?: string;
}

export class CliRunner implements NodeRunner {
  private readonly sessions = new Map<UUID, ProviderSession>();
  private readonly pendingApprovals = new Map<UUID, UUID>();
  private readonly pendingToolResolutions = new Map<UUID, ApprovalResolution>();
  private readonly promptBuilder: PromptBuilder;
  private readonly emitEvent: (runId: UUID, event: EventEnvelope) => void;
  private readonly logger: Logger;
  private readonly repoRoot: string;
  private readonly spawnNode?: (runId: UUID, fromNodeId: UUID, request: SpawnNodeRequest) => Promise<SpawnNodeResult>;
  private readonly createEdge?: (runId: UUID, fromNodeId: UUID, request: CreateEdgeRequest) => Promise<CreateEdgeResult>;
  private readonly sendHandoff?: (runId: UUID, fromNodeId: UUID, request: SendHandoffRequest) => Promise<SendHandoffResult>;

  constructor(options: CliRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.emitEvent = options.emitEvent;
    this.logger = options.logger ?? new ConsoleLogger();
    this.promptBuilder = new PromptBuilder(this.repoRoot, options.systemTemplatesDir, this.logger);
    this.spawnNode = options.spawnNode;
    this.createEdge = options.createEdge;
    this.sendHandoff = options.sendHandoff;
  }

  supports(_provider: ProviderName): boolean {
    return true;
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const session = await this.ensureSession(input);
    if (!session) {
      return {
        kind: "failed",
        summary: "Provider not configured",
        error: `Provider ${input.config.provider} is not configured`
      };
    }

    if (session.pendingTurn) {
      return this.resumePendingTurn(session, input);
    }

    const promptInput = this.injectReplayMessages(input, session);
    const toolProtocol = this.buildToolProtocol(session.config);
    const prompt = await this.promptBuilder.build(promptInput, { toolProtocol });
    const promptHeaderHash = this.buildPromptHeaderHash(prompt.artifacts);
    const promptKind = this.resolvePromptKind(session, promptHeaderHash);
    const promptPayload = promptKind === "full" ? prompt.artifacts.full : prompt.delta;

    try {
      session.interrupted = false;
      this.applyResumeArgs(session);
      await session.adapter.send({
        prompt: promptPayload,
        promptKind,
        turnId: newId()
      });
      this.updateSessionId(input.node, session);
      if (promptKind === "full") {
        session.lastPromptHeaderHash = promptHeaderHash;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "failed",
        summary: "Provider send failed",
        error: message,
        prompt: prompt.artifacts
      };
    }

    session.promptSent = true;
    const turnState: PendingTurn = {
      promptArtifacts: prompt.artifacts,
      partialOutput: "",
      promptLogged: false,
      inputMessages: input.messages
    };

    session.activeTurn = turnState;
    const outcome = await this.waitForOutcome(session, turnState);
    session.activeTurn = undefined;
    if (outcome.kind === "blocked") {
      session.pendingTurn = turnState;
      this.pendingApprovals.set(outcome.approval.approvalId, input.node.id);
      turnState.promptLogged = true;
      return {
        kind: "blocked",
        summary: outcome.summary,
        approval: outcome.approval,
        prompt: turnState.promptArtifacts
      };
    }

    if (outcome.kind === "interrupted") {
      this.recordTranscript(session, input.messages, outcome.message);
      session.completedTurns += 1;
      return {
        kind: "interrupted",
        summary: outcome.summary,
        message: outcome.message,
        prompt: prompt.artifacts
      };
    }

    if (outcome.kind === "failed") {
      return {
        kind: "failed",
        summary: outcome.summary,
        error: outcome.error,
        prompt: prompt.artifacts
      };
    }

    this.recordTranscript(session, input.messages, outcome.message);
    session.completedTurns += 1;
    return {
      kind: "completed",
      summary: outcome.summary,
      message: outcome.message,
      prompt: prompt.artifacts
    };
  }

  async resolveApproval(approvalId: UUID, resolution: ApprovalResolution): Promise<void> {
    if (this.resolveToolApproval(approvalId, resolution)) {
      return;
    }
    const nodeId = this.pendingApprovals.get(approvalId);
    if (!nodeId) {
      this.logger.warn("approval resolution without active session", { approvalId });
      return;
    }
    const session = this.sessions.get(nodeId);
    if (!session) {
      this.logger.warn("approval resolution missing session", { approvalId, nodeId });
      return;
    }
    try {
      await session.adapter.resolveApproval(approvalId, resolution);
      this.pendingApprovals.delete(approvalId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to forward approval resolution", { approvalId, nodeId, message });
    }
  }

  async resetNode(nodeId: UUID): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (!session) {
      this.logger.warn("reset requested without active session", { nodeId });
      return;
    }
    await session.adapter.resetSession();
    session.promptSent = false;
    session.pendingTurn = undefined;
    session.lastPromptHeaderHash = undefined;
    session.completedTurns = 0;
    session.transcript = [];
  }

  async closeNode(nodeId: UUID): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (!session) {
      return;
    }
    session.queue.clear();
    session.queue.push({ type: "error", error: new Error("Session closed") });
    session.pendingTurn = undefined;
    session.promptSent = false;
    try {
      await session.adapter.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("failed to close provider session", { nodeId, message });
    } finally {
      this.sessions.delete(nodeId);
      for (const [approvalId, pendingNodeId] of this.pendingApprovals.entries()) {
        if (pendingNodeId === nodeId) {
          this.pendingApprovals.delete(approvalId);
        }
      }
    }
  }

  async interruptNode(nodeId: UUID): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (!session || !session.activeTurn) {
      return;
    }
    session.interrupted = true;
    try {
      await session.adapter.interrupt();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("failed to interrupt provider session", { nodeId, message });
    }
    session.queue.push({ type: "interrupted" });
  }

  private resolvePromptKind(session: ProviderSession, promptHeaderHash: string): "full" | "delta" {
    if (!session.config.resume) {
      return "full";
    }
    if (!session.promptSent) {
      return "full";
    }
    if (session.lastPromptHeaderHash !== promptHeaderHash) {
      return "full";
    }
    return "delta";
  }

  private buildPromptHeaderHash(artifacts: PromptArtifacts): string {
    const header = [artifacts.blocks.system, artifacts.blocks.role]
      .filter((block) => block.trim().length > 0)
      .join("\n\n");
    return hashString(header);
  }

  private buildToolProtocol(config: ProviderConfig): string | undefined {
    if (config.transport !== "cli") {
      return undefined;
    }
    return CLI_TOOL_PROTOCOL;
  }

  private async resumePendingTurn(session: ProviderSession, input: TurnInput): Promise<TurnResult> {
    const pending = session.pendingTurn;
    if (!pending) {
      return {
        kind: "failed",
        summary: "Pending turn missing",
        error: "Pending turn missing"
      };
    }

    session.interrupted = false;
    session.activeTurn = pending;
    const outcome =
      pending.toolQueue && pending.toolQueue.length > 0
        ? await this.processToolQueue(session, pending)
        : await this.waitForOutcome(session, pending);
    session.activeTurn = undefined;
    if (outcome.kind === "blocked") {
      this.pendingApprovals.set(outcome.approval.approvalId, input.node.id);
      const prompt = pending.promptLogged ? undefined : pending.promptArtifacts;
      pending.promptLogged = true;
      return {
        kind: "blocked",
        summary: outcome.summary,
        approval: outcome.approval,
        prompt
      };
    }

    session.pendingTurn = undefined;
    if (outcome.kind === "interrupted") {
      const prompt = pending.promptLogged ? undefined : pending.promptArtifacts;
      pending.promptLogged = true;
      this.recordTranscript(session, pending.inputMessages, outcome.message);
      session.completedTurns += 1;
      return {
        kind: "interrupted",
        summary: outcome.summary,
        message: outcome.message,
        prompt
      };
    }
    if (outcome.kind === "failed") {
      const prompt = pending.promptLogged ? undefined : pending.promptArtifacts;
      return {
        kind: "failed",
        summary: outcome.summary,
        error: outcome.error,
        prompt
      };
    }

    const prompt = pending.promptLogged ? undefined : pending.promptArtifacts;
    this.recordTranscript(session, pending.inputMessages, outcome.message);
    session.completedTurns += 1;
    return {
      kind: "completed",
      summary: outcome.summary,
      message: outcome.message,
      prompt
    };
  }

  private async waitForOutcome(
    session: ProviderSession,
    pending: PendingTurn
  ): Promise<
    | { kind: "completed"; message: string; summary: string }
    | { kind: "interrupted"; message: string; summary: string }
    | { kind: "blocked"; approval: ApprovalRequest; summary: string }
    | { kind: "failed"; error: string; summary: string }
  > {
    const allowApprovals = session.config.permissionsMode === "gated";
    while (true) {
      const signal = await session.queue.next();
      if (signal.type === "message.assistant.delta") {
        pending.partialOutput += signal.delta;
        continue;
      }
      if (signal.type === "message.assistant.final") {
        const message = signal.content.trim().length > 0 ? signal.content : pending.partialOutput;
        const toolCalls = signal.toolCalls ?? [];
        const shouldParseToolCalls = this.shouldParseToolCallLines(session);
        const extracted = shouldParseToolCalls
          ? this.extractToolCalls(message, session.config.nodeId)
          : { message, toolCalls: [] };
        if (toolCalls.length > 0) {
          if (extracted.toolCalls.length > 0) {
            this.logger.warn("tool_call JSON ignored because native tool calls are present", {
              nodeId: session.config.nodeId,
              count: extracted.toolCalls.length
            });
          }
          pending.toolQueue = toolCalls;
          pending.toolMessage = extracted.message;
          pending.toolErrors = [];
          return this.processToolQueue(session, pending);
        }
        if (extracted.toolCalls.length > 0) {
          pending.toolQueue = extracted.toolCalls;
          pending.toolMessage = extracted.message;
          pending.toolErrors = [];
          return this.processToolQueue(session, pending);
        }
        const summary = this.summarize(extracted.message);
        return { kind: "completed", message: extracted.message, summary };
      }
      if (signal.type === "interrupted") {
        return { kind: "interrupted", message: pending.partialOutput, summary: "interrupted" };
      }
      if (signal.type === "approval.requested" && allowApprovals) {
        const toolName = signal.approval.tool.name;
        return {
          kind: "blocked",
          approval: signal.approval,
          summary: `approval required: ${toolName}`
        };
      }
      if (signal.type === "error") {
        return {
          kind: "failed",
          summary: "Provider error",
          error: signal.error.message
        };
      }
    }
  }

  private summarize(message: string): string {
    const trimmed = message.trim();
    if (!trimmed) {
      return "completed";
    }
    const firstLine = trimmed.split("\n")[0];
    const maxLength = 140;
    if (firstLine.length <= maxLength) {
      return firstLine;
    }
    return `${firstLine.slice(0, maxLength - 3)}...`;
  }

  private applyResumeArgs(session: ProviderSession): void {
    if (session.config.transport === "api") {
      return;
    }
    const baseArgs = session.baseArgs ?? [];
    const resumeArgs = session.resumeArgs ?? [];
    const shouldResume =
      session.config.resume && session.completedTurns > 0 && resumeArgs.length > 0;
    session.config.args = shouldResume ? [...baseArgs, ...resumeArgs] : [...baseArgs];
  }

  private injectReplayMessages(input: TurnInput, session: ProviderSession): TurnInput {
    if (!this.shouldReplay(session)) {
      return input;
    }
    const history = this.getReplayMessages(session);
    if (history.length === 0) {
      return input;
    }
    return {
      ...input,
      messages: [...history, ...input.messages]
    };
  }

  private shouldReplay(session: ProviderSession): boolean {
    if (session.replayTurns <= 0) {
      return false;
    }
    return (session.resumeArgs?.length ?? 0) === 0;
  }

  private getReplayMessages(session: ProviderSession): UserMessageRecord[] {
    const maxMessages = session.replayTurns * 2;
    if (maxMessages <= 0 || session.transcript.length === 0) {
      return [];
    }
    return session.transcript.slice(-maxMessages);
  }

  private recordTranscript(
    session: ProviderSession,
    incoming: UserMessageRecord[],
    assistantMessage?: string
  ): void {
    if (session.replayTurns <= 0) {
      return;
    }
    session.transcript.push(...incoming);
    const content = assistantMessage?.trim();
    if (content) {
      session.transcript.push({
        id: newId(),
        runId: session.config.runId,
        nodeId: session.config.nodeId,
        role: "assistant",
        content,
        createdAt: nowIso()
      });
    }
    const maxMessages = session.replayTurns * 2;
    if (maxMessages > 0 && session.transcript.length > maxMessages) {
      session.transcript = session.transcript.slice(-maxMessages);
    }
  }

  private resolveToolApproval(approvalId: UUID, resolution: ApprovalResolution): boolean {
    const session = this.findSessionWithToolApproval(approvalId);
    if (!session) {
      return false;
    }
    if (this.pendingToolResolutions.has(approvalId)) {
      return true;
    }
    this.pendingToolResolutions.set(approvalId, resolution);
    this.pendingApprovals.delete(approvalId);
    this.logger.info("tool approval resolved", {
      approvalId,
      nodeId: session.config.nodeId,
      status: resolution.status
    });
    return true;
  }

  private findSessionWithToolApproval(approvalId: UUID): ProviderSession | null {
    for (const session of this.sessions.values()) {
      const pending = session.pendingTurn;
      if (pending?.toolQueue?.some((tool) => tool.id === approvalId)) {
        return session;
      }
      const active = session.activeTurn;
      if (active?.toolQueue?.some((tool) => tool.id === approvalId)) {
        return session;
      }
    }
    return null;
  }

  private shouldParseToolCallLines(session: ProviderSession): boolean {
    return session.config.transport === "cli";
  }

  private extractToolCalls(message: string, nodeId?: UUID): { message: string; toolCalls: ToolCall[] } {
    const lines = message.split("\n");
    const toolCalls: ToolCall[] = [];
    const keptLines: string[] = [];

    for (const line of lines) {
      const toolCall = this.parseToolCallLine(line, nodeId);
      if (toolCall) {
        toolCalls.push(toolCall);
        continue;
      }
      keptLines.push(line);
    }

    if (toolCalls.length === 0) {
      return { message, toolCalls };
    }

    return { message: keptLines.join("\n").trim(), toolCalls };
  }

  private parseToolCallLine(line: string, nodeId?: UUID): ToolCall | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      this.logger.warn("failed to parse tool call JSON", {
        nodeId,
        message: String(error)
      });
      return null;
    }
    if (!this.isRecord(parsed)) {
      return null;
    }
    const container = this.isRecord(parsed.tool_call)
      ? parsed.tool_call
      : this.isRecord(parsed.toolCall)
        ? parsed.toolCall
        : null;
    if (!container) {
      const directName =
        typeof parsed.tool === "string"
          ? parsed.tool.trim()
          : typeof parsed.name === "string"
            ? parsed.name.trim()
            : "";
      const directArgs = this.isRecord(parsed.args)
        ? parsed.args
        : this.isRecord(parsed.params)
          ? parsed.params
          : null;
      if (!directName || !directArgs) {
        return null;
      }
      const directId = typeof parsed.id === "string" ? parsed.id.trim() : "";
      const id = directId.length > 0 ? directId : newId();
      this.logger.warn("nonstandard tool_call JSON shape; prefer tool_call wrapper", {
        nodeId,
        tool: directName
      });
      return { id, name: directName, args: directArgs };
    }
    const name = typeof container.name === "string" ? container.name.trim() : "";
    const args = this.isRecord(container.args)
      ? container.args
      : this.isRecord(container.params)
        ? container.params
        : null;
    if (!this.isRecord(container.args) && this.isRecord(container.params)) {
      this.logger.warn("tool_call JSON used params; prefer args", {
        nodeId,
        tool: name
      });
    }
    const idValue = typeof container.id === "string" ? container.id.trim() : "";
    const id = idValue.length > 0 ? idValue : newId();
    if (!name || !args) {
      return null;
    }
    return { id, name, args };
  }

  private async processToolQueue(
    session: ProviderSession,
    pending: PendingTurn
  ): Promise<
    | { kind: "completed"; message: string; summary: string }
    | { kind: "blocked"; approval: ApprovalRequest; summary: string }
    | { kind: "failed"; error: string; summary: string }
  > {
    const toolQueue = pending.toolQueue ?? [];
    const baseMessage = pending.toolMessage ?? pending.partialOutput;
    const toolErrors = pending.toolErrors ?? [];
    pending.toolErrors = toolErrors;

    if (!pending.toolProposed) {
      for (const tool of toolQueue) {
        this.emitToolProposed(session, tool);
      }
      pending.toolProposed = true;
    }

    if (toolQueue.length === 0) {
      const message = this.appendToolErrors(baseMessage, toolErrors);
      return { kind: "completed", message, summary: this.summarize(message) };
    }

    const toolOptions = this.buildToolExecutionOptions(session);

    while (toolQueue.length > 0) {
      let tool = toolQueue[0];
      if (this.isAgentManagementTool(tool) && !this.canSpawnNodes(session)) {
        const errorMessage = "spawnNodes capability is disabled";
        this.emitToolCompleted(session, tool.id, { ok: false, output: "" }, errorMessage);
        this.logger.warn("tool blocked by capabilities", {
          nodeId: session.config.nodeId,
          tool: tool.name,
          toolId: tool.id
        });
        toolErrors.push(`${tool.name}: ${errorMessage}`);
        toolQueue.shift();
        continue;
      }
      if (this.requiresToolApproval(session, tool)) {
        const resolution = this.pendingToolResolutions.get(tool.id);
        if (!resolution) {
          this.logger.info("tool approval required", {
            nodeId: session.config.nodeId,
            tool: tool.name,
            toolId: tool.id
          });
          return {
            kind: "blocked",
            approval: this.buildApprovalRequest(session, tool),
            summary: `approval required: ${tool.name}`
          };
        }
        this.pendingToolResolutions.delete(tool.id);
        if (resolution.status === "denied") {
          const errorMessage = "Tool denied by user";
          this.emitToolCompleted(session, tool.id, { ok: false }, errorMessage);
          toolErrors.push(`${tool.name}: ${errorMessage}`);
          break;
        }
        if (resolution.status === "modified" && resolution.modifiedArgs) {
          tool = { ...tool, args: resolution.modifiedArgs };
          toolQueue[0] = tool;
        }
      }

      this.emitToolStarted(session, tool);
      this.logger.info("tool execution started", { nodeId: session.config.nodeId, tool: tool.name, toolId: tool.id });
      let result: ToolExecutionResult;
      try {
        result = await executeToolCall(tool, toolOptions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("tool execution failed", { nodeId: session.config.nodeId, tool: tool.name, toolId: tool.id, message });
        return { kind: "failed", summary: "Tool execution failed", error: message };
      }
      this.emitToolCompleted(session, tool.id, result, result.error);
      this.logger.info("tool execution completed", {
        nodeId: session.config.nodeId,
        tool: tool.name,
        toolId: tool.id,
        ok: result.ok
      });
      if (!result.ok) {
        const errorMessage = result.error ?? "tool failed";
        toolErrors.push(`${tool.name}: ${errorMessage}`);
      }
      toolQueue.shift();
    }

    pending.toolQueue = undefined;
    pending.toolMessage = undefined;
    pending.toolErrors = undefined;
    pending.toolProposed = undefined;

    const message = this.appendToolErrors(baseMessage, toolErrors);
    return { kind: "completed", message, summary: this.summarize(message) };
  }

  private buildToolExecutionOptions(session: ProviderSession) {
    return {
      cwd: session.config.cwd ?? this.repoRoot,
      capabilities: session.config.capabilities,
      globalMode: session.config.globalMode,
      defaultProvider: session.config.provider,
      spawnNode: session.config.spawnNode,
      createEdge: session.config.createEdge,
      sendHandoff: session.config.sendHandoff,
      logger: this.logger
    };
  }

  private canSpawnNodes(session: ProviderSession): boolean {
    const capabilities = session.config.capabilities;
    if (!capabilities) {
      return true;
    }
    return capabilities.spawnNodes;
  }

  private isAgentManagementTool(tool: ToolCall): boolean {
    return tool.name === "spawn_node" || tool.name === "create_edge";
  }

  private requiresToolApproval(session: ProviderSession, tool: ToolCall): boolean {
    if (session.config.permissionsMode === "gated") {
      return true;
    }
    if (session.config.agentManagementRequiresApproval !== true) {
      return false;
    }
    return this.isAgentManagementTool(tool);
  }

  private buildApprovalRequest(session: ProviderSession, tool: ToolCall): ApprovalRequest {
    return {
      approvalId: tool.id,
      nodeId: session.config.nodeId,
      tool,
      context: this.buildApprovalContext(tool)
    };
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

  private emitToolProposed(session: ProviderSession, tool: ToolCall): void {
    this.emitEvent(session.config.runId, {
      id: newId(),
      runId: session.config.runId,
      ts: nowIso(),
      type: "tool.proposed",
      nodeId: session.config.nodeId,
      tool
    });
  }

  private emitToolStarted(session: ProviderSession, tool: ToolCall): void {
    this.emitEvent(session.config.runId, {
      id: newId(),
      runId: session.config.runId,
      ts: nowIso(),
      type: "tool.started",
      nodeId: session.config.nodeId,
      tool
    });
  }

  private emitToolCompleted(
    session: ProviderSession,
    toolId: UUID,
    result: { ok: boolean; output?: string | object },
    errorMessage?: string
  ): void {
    this.emitEvent(session.config.runId, {
      id: newId(),
      runId: session.config.runId,
      ts: nowIso(),
      type: "tool.completed",
      nodeId: session.config.nodeId,
      toolId,
      result,
      error: errorMessage ? { message: errorMessage } : undefined
    });
  }

  private appendToolErrors(message: string, toolErrors: string[]): string {
    if (toolErrors.length === 0) {
      return message;
    }
    const prefix = message.trim().length > 0 ? `${message}\n\n` : "";
    return `${prefix}Tool errors:\n${toolErrors.map((error) => `- ${error}`).join("\n")}`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private applyCliPermissionFlags(config: CliProviderConfig): CliProviderConfig {
    if (config.permissionsMode !== "skip") {
      return config;
    }
    const args = [...(config.args ?? [])];
    if (config.provider === "claude") {
      if (!args.includes("--dangerously-skip-permissions")) {
        args.push("--dangerously-skip-permissions");
      }
    }
    if (config.provider === "gemini") {
      if (!args.includes("--yolo")) {
        args.push("--yolo");
      }
    }
    return { ...config, args };
  }

  private async ensureSession(input: TurnInput): Promise<ProviderSession | null> {
    const existing = this.sessions.get(input.node.id);
    if (existing) {
      this.refreshSessionConfig(existing, input);
      return existing;
    }
    const spec = this.resolveProviderSpec(input.config.provider);
    if (!spec) {
      return null;
    }

    const statelessProtocol =
      spec.protocol === "raw" || (spec.protocol === "stream-json" && !spec.statefulStreaming);
    const resume = statelessProtocol ? false : input.config.session.resume;
    if (!resume && input.config.session.resume) {
      this.logger.warn("stateless protocol disables session resume; forcing full prompts", {
        nodeId: input.node.id,
        provider: input.config.provider,
        protocol: spec.protocol ?? "jsonl"
      });
    }
    const baseConfig = {
      runId: input.run.id,
      nodeId: input.node.id,
      provider: input.config.provider,
      cwd: input.run.cwd ?? this.repoRoot,
      permissionsMode: resolvePermissionsMode(input.config.permissions.cliPermissionsMode),
      agentManagementRequiresApproval: input.node.permissions.agentManagementRequiresApproval,
      spawnNode: this.spawnNode
        ? (request: SpawnNodeRequest) => this.spawnNode?.(input.run.id, input.node.id, request)
        : undefined,
      createEdge: this.createEdge
        ? (request: CreateEdgeRequest) => this.createEdge?.(input.run.id, input.node.id, request)
        : undefined,
      sendHandoff: this.sendHandoff
        ? (request: SendHandoffRequest) => this.sendHandoff?.(input.run.id, input.node.id, request)
        : undefined,
      resume,
      resetCommands: input.config.session.resetCommands,
      capabilities: input.node.capabilities,
      globalMode: input.run.globalMode
    };

    const config =
      spec.transport === "api"
        ? ({
          ...(baseConfig as ApiProviderConfig),
          transport: "api",
          apiKey: spec.apiKey as string,
          apiBaseUrl: spec.apiBaseUrl,
          model: spec.model as string,
          maxTokens: spec.maxTokens
        } satisfies ApiProviderConfig)
        : ({
          ...(baseConfig as CliProviderConfig),
          transport: "cli",
          command: spec.command ?? input.config.provider,
          args: spec.args ?? [],
          protocol: spec.protocol ?? "jsonl"
        } satisfies CliProviderConfig);

    const resolvedConfig =
      config.transport === "cli" ? this.applyCliPermissionFlags(config) : config;
    const adapter = createProviderAdapter(resolvedConfig, this.logger);
    const queue = new AsyncQueue<TurnSignal>();
    const isCli = resolvedConfig.transport !== "api";
    const baseArgs = isCli ? [...(resolvedConfig.args ?? [])] : undefined;
    const session: ProviderSession = {
      adapter,
      queue,
      config: resolvedConfig,
      promptSent: false,
      completedTurns: 0,
      baseArgs,
      resumeArgs: isCli ? [...(spec.resumeArgs ?? [])] : undefined,
      replayTurns: spec.replayTurns ?? 0,
      transcript: [],
      statelessProtocol
    };

    adapter.onEvent((event: EventEnvelope) => this.handleAdapterEvent(session, event));
    adapter.onError((error: Error) => {
      this.logger.error("provider adapter error", { nodeId: input.node.id, message: error.message });
      queue.push({ type: "error", error });
    });

    try {
      await adapter.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to start provider adapter", { nodeId: input.node.id, message });
      return null;
    }
    this.updateSessionId(input.node, session);
    this.sessions.set(input.node.id, session);
    return session;
  }

  private refreshSessionConfig(session: ProviderSession, input: TurnInput): void {
    const config = session.config;
    const nextPermissionsMode = resolvePermissionsMode(input.config.permissions.cliPermissionsMode);
    const nextSpawnNodes = input.node.capabilities.spawnNodes;
    const prevSpawnNodes = config.capabilities?.spawnNodes;
    const prevPermissionsMode = config.permissionsMode;

    config.cwd = input.run.cwd ?? this.repoRoot;
    config.globalMode = input.run.globalMode;
    config.capabilities = input.node.capabilities;
    config.permissionsMode = nextPermissionsMode;
    config.agentManagementRequiresApproval = input.node.permissions.agentManagementRequiresApproval;
    config.resetCommands = input.config.session.resetCommands;
    const requestedResume = input.config.session.resume;
    if (session.statelessProtocol && requestedResume) {
      this.logger.warn("stateless protocol disables session resume; keeping resume disabled", {
        nodeId: input.node.id,
        provider: input.config.provider,
        protocol: session.config.transport === "cli" ? session.config.protocol : undefined
      });
    }
    config.resume = session.statelessProtocol ? false : requestedResume;

    if (prevSpawnNodes !== undefined && prevSpawnNodes !== nextSpawnNodes) {
      this.logger.info("node capabilities updated", {
        nodeId: input.node.id,
        spawnNodes: nextSpawnNodes
      });
    }
    if (prevPermissionsMode !== nextPermissionsMode) {
      this.logger.info("node permissions mode updated", {
        nodeId: input.node.id,
        permissionsMode: nextPermissionsMode
      });
    }
  }

  private updateSessionId(node: NodeState, session: ProviderSession): void {
    const sessionId = session.adapter.getSessionId();
    if (!sessionId || session.sessionId === sessionId) {
      return;
    }
    session.sessionId = sessionId;
    this.emitEvent(node.runId, {
      id: newId(),
      runId: node.runId,
      ts: nowIso(),
      type: "node.patch",
      nodeId: node.id,
      patch: {
        session: {
          sessionId,
          resetCommands: session.config.resetCommands
        }
      }
    });
  }

  private handleAdapterEvent(session: ProviderSession, event: EventEnvelope): void {
    if (event.type === "message.assistant.delta") {
      if (session.interrupted) {
        return;
      }
      this.emitEvent(event.runId, event);
      session.queue.push({ type: "message.assistant.delta", delta: event.delta });
      return;
    }
    if (event.type === "message.assistant.final") {
      if (session.interrupted) {
        return;
      }
      session.queue.push({
        type: "message.assistant.final",
        content: event.content,
        toolCalls: event.toolCalls
      });
      return;
    }
    // Forward thinking events to UI
    if (event.type === "message.assistant.thinking.delta" || event.type === "message.assistant.thinking.final") {
      if (session.interrupted) {
        return;
      }
      this.emitEvent(event.runId, event);
      return;
    }
    if (event.type === "tool.proposed" || event.type === "tool.started" || event.type === "tool.completed") {
      this.emitEvent(event.runId, event);
      return;
    }
    if (event.type === "node.patch") {
      this.emitEvent(event.runId, event);
      return;
    }
    if (event.type === "telemetry.usage") {
      this.emitEvent(event.runId, event);
      return;
    }
    if (event.type === "approval.requested") {
      if (session.config.permissionsMode === "skip") {
        this.emitEvent(event.runId, event);
        return;
      }
      session.queue.push({
        type: "approval.requested",
        approval: {
          approvalId: event.approvalId,
          nodeId: event.nodeId,
          tool: event.tool,
          context: event.context
        }
      });
      return;
    }
    if (event.type === "approval.resolved") {
      if (session.config.permissionsMode === "skip") {
        this.emitEvent(event.runId, event);
      }
      return;
    }
  }

  private resolveProviderSpec(provider: ProviderName): ProviderSpec | null {
    const prefix = provider.toUpperCase();
    const transportEnv = this.readEnv(`VUHLP_${prefix}_TRANSPORT`);
    const transport = transportEnv?.toLowerCase() === "api" ? "api" : "cli";
    const statefulDefault = provider === "claude";
    const statefulStreaming = this.readEnvFlag(
      `VUHLP_${prefix}_STATEFUL_STREAMING`,
      statefulDefault
    );
    const resumeArgsRaw = this.parseArgs(this.readEnv(`VUHLP_${prefix}_RESUME_ARGS`));
    const resumeArgs = resumeArgsRaw.length > 0 ? resumeArgsRaw : this.defaultResumeArgs(provider);
    const replayTurnsRaw = this.readEnv(`VUHLP_${prefix}_REPLAY_TURNS`);
    let replayTurns = 0;
    if (replayTurnsRaw) {
      const parsed = Number(replayTurnsRaw);
      replayTurns = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    }

    if (transport === "api") {
      const apiKey = this.readEnv(`VUHLP_${prefix}_API_KEY`);
      const model = this.readEnv(`VUHLP_${prefix}_MODEL`);
      if (apiKey && model) {
        const apiBaseUrl = this.readEnv(`VUHLP_${prefix}_API_URL`);
        const maxTokensRaw = this.readEnv(`VUHLP_${prefix}_MAX_TOKENS`);
        const maxTokens = maxTokensRaw ? Number(maxTokensRaw) : undefined;
      return this.applyStreamingDefaults(provider, {
        transport: "api",
        apiKey,
        apiBaseUrl,
        model,
        maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined
      });
    }
      this.logger.warn("api transport requested but missing credentials, falling back to CLI", {
        provider,
        hasApiKey: Boolean(apiKey),
        hasModel: Boolean(model)
      });
    }

    const explicitCommand = this.readEnv(`VUHLP_${prefix}_COMMAND`);
    const command = explicitCommand ?? provider;
    const args = this.parseArgs(this.readEnv(`VUHLP_${prefix}_ARGS`));
    const protocol = this.parseProtocol(this.readEnv(`VUHLP_${prefix}_PROTOCOL`));
    if (provider === "custom" && !explicitCommand) {
      return null;
    }
    return this.applyStreamingDefaults(provider, {
      transport: "cli",
      command,
      args,
      protocol,
      statefulStreaming,
      resumeArgs,
      replayTurns
    });
  }

  private readEnv(name: string): string | undefined {
    const value = process.env[name];
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private readEnvFlag(name: string, defaultValue = false): boolean {
    const value = this.readEnv(name);
    if (!value) {
      return defaultValue;
    }
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }

  private parseArgs(raw?: string): string[] {
    if (!raw) {
      return [];
    }
    return raw.split(/\s+/).filter((value) => value.length > 0);
  }

  private parseProtocol(raw?: string): ProviderProtocol | undefined {
    if (!raw) {
      return undefined;
    }
    if (raw === "raw") {
      return "raw";
    }
    if (raw === "stream-json") {
      return "stream-json";
    }
    if (raw === "jsonl") {
      return "jsonl";
    }
    return "jsonl";
  }

  private defaultResumeArgs(provider: ProviderName): string[] {
    if (provider === "claude") {
      return ["--continue"];
    }
    return [];
  }

  private applyStreamingDefaults(provider: ProviderName, spec: ProviderSpec): ProviderSpec {
    if (spec.transport !== "cli") {
      return spec;
    }

    const command = (spec.command ?? provider).toLowerCase();
    const args = [...(spec.args ?? [])];

    if (provider === "claude" && command.includes("claude")) {
      const hasPrint = args.includes("--print");
      const hasOutputFormat =
        args.some((arg) => arg === "--output-format" || arg.startsWith("--output-format="));
      const outputFormatValue = this.getCliOptionValue(args, "--output-format");
      const hasPartialMessages = args.includes("--include-partial-messages");
      const shouldWarnProtocol = spec.protocol && spec.protocol !== "stream-json";

      if (!hasPrint) {
        args.push("--print");
      }
      if (!hasOutputFormat) {
        args.push("--output-format", "stream-json");
      } else if (outputFormatValue && outputFormatValue !== "stream-json") {
        this.logger.warn("Claude CLI output format is not stream-json; streaming may be disabled", {
          provider,
          outputFormat: outputFormatValue
        });
      }
      if (!hasPartialMessages) {
        args.push("--include-partial-messages");
      }
      if (shouldWarnProtocol) {
        this.logger.warn("Claude CLI protocol overridden to stream-json for streaming enforcement", {
          provider,
          protocol: spec.protocol
        });
      }

      return {
        ...spec,
        command: spec.command ?? provider,
        args,
        protocol: "stream-json"
      };
    }

    if (provider === "codex" && command.includes("codex") && args.length === 0) {
      args.push("exec", "--json", "-");
      const shouldWarnProtocol = spec.protocol && spec.protocol !== "stream-json";
      if (shouldWarnProtocol) {
        this.logger.warn("Codex CLI protocol overridden to stream-json for streaming enforcement", {
          provider,
          protocol: spec.protocol
        });
      }
      return {
        ...spec,
        command: spec.command ?? provider,
        args,
        protocol: "stream-json"
      };
    }

    if (provider === "gemini" && command.includes("gemini")) {
      const hasOutputFormat =
        args.some((arg) => arg === "--output-format" || arg.startsWith("--output-format="));
      const outputFormatValue = this.getCliOptionValue(args, "--output-format");
      const shouldWarnProtocol = spec.protocol && spec.protocol !== "stream-json";

      if (!hasOutputFormat) {
        args.push("--output-format", "stream-json");
      } else if (outputFormatValue && outputFormatValue !== "stream-json") {
        this.logger.warn("Gemini CLI output format is not stream-json; streaming may be disabled", {
          provider,
          outputFormat: outputFormatValue
        });
      }
      if (shouldWarnProtocol) {
        this.logger.warn("Gemini CLI protocol overridden to stream-json for streaming enforcement", {
          provider,
          protocol: spec.protocol
        });
      }

      return {
        ...spec,
        command: spec.command ?? provider,
        args,
        protocol: "stream-json"
      };
    }

    return spec;
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
}
