import type {
  ApprovalRequest,
  ApprovalResolution,
  EventEnvelope,
  NodeConfig,
  NodeState,
  PromptArtifacts,
  ProviderName,
  RunState,
  TodoItem,
  TodoStatus,
  ToolCall,
  UserMessageRecord,
  UUID
} from "@vuhlp/contracts";
import {
  ConsoleLogger,
  createProviderAdapter,
  executeToolCall,
  getProviderNativeToolNames,
  getVuhlpToolNames,
  resolvePermissionsMode,
  type ApiProviderConfig,
  type CliProviderConfig,
  type CreateEdgeRequest,
  type CreateEdgeResult,
  type Logger,
  type ProviderAdapter,
  type ProviderConfig,
  type SendHandoffRequest,
  type SendHandoffResult,
  type SpawnNodeRequest,
  type SpawnNodeResult,
  type ToolExecutionResult
} from "@vuhlp/providers";
import { AsyncQueue } from "./async-queue.js";
import { PromptBuilder } from "./prompt-builder.js";
import { ProviderResolver, type ProviderSpec } from "./provider-resolver.js";
import type { NodeRunner, TurnInput, TurnResult } from "./runner.js";
import { SessionStateManager } from "./session-state-manager.js";
import { extractToolCalls, isRecord, mergeToolCalls } from "./tool-call-parser.js";
import { CLI_TOOL_PROTOCOL_PROVIDER_NATIVE, CLI_TOOL_PROTOCOL_VUHLP } from "./tool-protocols.js";
import { hashString, newId, nowIso } from "./utils.js";

const VUHLP_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...getVuhlpToolNames()
]);
const PROVIDER_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...getProviderNativeToolNames()
]);

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
  pendingTurn?: PendingTurn;
  activeTurn?: PendingTurn;
  sessionId?: string;
  interrupted?: boolean;
  state: SessionStateManager;
}

type TurnSignal =
  | { type: "message.assistant.delta"; delta: string }
  | { type: "message.assistant.final"; content: string; toolCalls?: ToolCall[] }
  | { type: "interrupted" }
  | { type: "approval.requested"; approval: ApprovalRequest }
  | { type: "error"; error: Error };

export interface CliRunnerOptions {
  repoRoot: string;
  appRoot: string;
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
  private readonly providerResolver: ProviderResolver;
  private readonly emitEvent: (runId: UUID, event: EventEnvelope) => void;
  private readonly logger: Logger;
  private readonly repoRoot: string;
  private readonly appRoot: string;
  private readonly spawnNode?: (runId: UUID, fromNodeId: UUID, request: SpawnNodeRequest) => Promise<SpawnNodeResult>;
  private readonly createEdge?: (runId: UUID, fromNodeId: UUID, request: CreateEdgeRequest) => Promise<CreateEdgeResult>;
  private readonly sendHandoff?: (runId: UUID, fromNodeId: UUID, request: SendHandoffRequest) => Promise<SendHandoffResult>;

  constructor(options: CliRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.appRoot = options.appRoot;
    this.emitEvent = options.emitEvent;
    this.logger = options.logger ?? new ConsoleLogger();
    this.promptBuilder = new PromptBuilder(this.repoRoot, options.systemTemplatesDir, this.logger);
    this.providerResolver = new ProviderResolver({ appRoot: this.appRoot, logger: this.logger });
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

    const { input: promptInput, replayed } = session.state.injectReplayMessages(input);
    const toolProtocol = this.buildToolProtocol(session.config);
    const prompt = await this.promptBuilder.build(promptInput, { toolProtocol });
    const promptHeaderHash = this.buildPromptHeaderHash(prompt.artifacts);
    const promptKind = session.state.resolvePromptKind(session.config.resume, promptHeaderHash);
    const promptPayload = promptKind === "full" ? prompt.artifacts.full : prompt.delta;

    try {
      session.interrupted = false;
      session.state.applyResumeArgs(session.config);
      await session.adapter.send({
        prompt: promptPayload,
        promptKind,
        turnId: newId()
      });
      this.updateSessionId(input.node, session);
      const clearedReplay = session.state.clearReplayFlag();
      if (clearedReplay && replayed) {
        this.logger.info("replayed transcript after reconnect", {
          runId: session.config.runId,
          nodeId: session.config.nodeId,
          provider: session.config.provider,
          replayTurns: session.state.getReplayTurns()
        });
      }
      session.state.notePromptSent(promptKind, promptHeaderHash);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "failed",
        summary: "Provider send failed",
        error: message,
        prompt: prompt.artifacts
      };
    }

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
      session.state.recordTranscript(input.messages, outcome.message);
      session.state.markTurnCompleted();
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

    session.state.recordTranscript(input.messages, outcome.message);
    session.state.markTurnCompleted();
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
      this.logger.error("failed to forward approval resolution", {
        approvalId,
        nodeId,
        runId: session.config.runId,
        message
      });
    }
  }

  async startNode(input: { run: RunState; node: NodeState; config: NodeConfig }): Promise<void> {
    const session = await this.ensureSession({
      run: input.run,
      node: input.node,
      config: input.config,
      envelopes: [],
      messages: []
    });
    if (!session) {
      throw new Error(`Provider ${input.config.provider} is not configured`);
    }
    try {
      await session.adapter.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to start provider session", {
        runId: input.run.id,
        nodeId: input.node.id,
        provider: input.config.provider,
        message
      });
      throw error;
    }
    this.updateSessionId(input.node, session);
  }

  async resetNode(nodeId: UUID): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (!session) {
      this.logger.warn("reset requested without active session", { nodeId });
      return;
    }
    await session.adapter.resetSession();
    session.pendingTurn = undefined;
    session.state.resetForSessionReset();
  }

  async stopNode(nodeId: UUID): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (!session) {
      return;
    }
    const hadActiveTurn = Boolean(session.activeTurn);
    session.queue.clear();
    if (hadActiveTurn) {
      session.queue.push({ type: "error", error: new Error("Session stopped") });
    }
    session.pendingTurn = undefined;
    session.activeTurn = undefined;
    session.state.markDisconnected();
    try {
      await session.adapter.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("failed to close provider session", {
        runId: session.config.runId,
        nodeId,
        message
      });
    }
    for (const [approvalId, pendingNodeId] of this.pendingApprovals.entries()) {
      if (pendingNodeId === nodeId) {
        this.pendingApprovals.delete(approvalId);
      }
    }
  }

  async disposeNode(nodeId: UUID): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (!session) {
      return;
    }
    await this.stopNode(nodeId);
    session.state.resetForSessionReset();
    this.sessions.delete(nodeId);
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
      this.logger.warn("failed to interrupt provider session", {
        runId: session.config.runId,
        nodeId,
        message
      });
    }
    session.queue.push({ type: "interrupted" });
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
    if (config.nativeToolHandling === "provider") {
      return CLI_TOOL_PROTOCOL_PROVIDER_NATIVE;
    }
    return CLI_TOOL_PROTOCOL_VUHLP;
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
      session.state.recordTranscript(pending.inputMessages, outcome.message);
      session.state.markTurnCompleted();
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
    session.state.recordTranscript(pending.inputMessages, outcome.message);
    session.state.markTurnCompleted();
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
          ? extractToolCalls(
            message,
            session.config.nodeId,
            this.logger,
            this.getToolCallParseOptions(session)
          )
          : { message, toolCalls: [] };
        const combinedToolCalls = mergeToolCalls(
          toolCalls,
          extracted.toolCalls,
          session.config.nodeId,
          this.logger
        );
        if (combinedToolCalls.length > 0) {
          pending.toolQueue = combinedToolCalls;
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
      runId: session.config.runId,
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

  private getToolCallParseOptions(session: ProviderSession) {
    if (session.config.transport !== "cli") {
      return undefined;
    }
    if (session.config.protocol !== "stream-json") {
      return undefined;
    }
    return {
      strictWrapper: true,
      allowlist: VUHLP_TOOL_NAMES
    };
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
      const providerNativeGuard = this.guardProviderNativeToolCall(session, tool);
      if (providerNativeGuard) {
        const errorMessage = providerNativeGuard;
        this.emitToolCompleted(session, tool.id, { ok: false, output: "" }, errorMessage);
        this.logger.warn("provider-native tool_call ignored", {
          runId: session.config.runId,
          nodeId: session.config.nodeId,
          tool: tool.name,
          toolId: tool.id,
          provider: session.config.provider
        });
        toolErrors.push(`${tool.name}: ${errorMessage}`);
        toolQueue.shift();
        continue;
      }
      const agentManagementGuard = this.guardAgentManagementTool(session, tool);
      if (agentManagementGuard) {
        const errorMessage = agentManagementGuard;
        this.emitToolCompleted(session, tool.id, { ok: false, output: "" }, errorMessage);
        this.logger.warn("tool blocked by capabilities", {
          runId: session.config.runId,
          nodeId: session.config.nodeId,
          tool: tool.name,
          toolId: tool.id,
          edgeManagement: session.config.capabilities?.edgeManagement
        });
        toolErrors.push(`${tool.name}: ${errorMessage}`);
        toolQueue.shift();
        continue;
      }
      if (this.requiresToolApproval(session, tool)) {
        const resolution = this.pendingToolResolutions.get(tool.id);
        if (!resolution) {
          this.logger.info("tool approval required", {
            runId: session.config.runId,
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

      // Intercept TodoWrite tool calls - extract todos and emit patch
      // Provider-wrapped tools have: tool.name="provider_tool", tool.args.name="TodoWrite", tool.args.input={todos:[...]}
      // Direct tools would have: tool.name="TodoWrite", tool.args.todos=[...]
      this.logger.debug("processing tool in queue", {
        toolName: tool.name,
        argsName: String(tool.args.name),
        hasInput: "input" in tool.args,
        argsKeys: Object.keys(tool.args)
      });
      const isProviderTodoWrite = tool.name === "provider_tool" && tool.args.name === "TodoWrite";
      const isDirectTodoWrite = tool.name === "TodoWrite";
      this.logger.debug("TodoWrite check", { isProviderTodoWrite, isDirectTodoWrite });
      if (isProviderTodoWrite || isDirectTodoWrite) {
        const argsToUse = isProviderTodoWrite && isRecord(tool.args.input) ? tool.args.input : tool.args;
        this.logger.debug("TodoWrite args to parse", { argsToUse });
        const todos = this.parseTodoWriteArgs(argsToUse);
        this.logger.debug("parsed todos", { todosCount: todos?.length ?? 0, todos });
        if (todos) {
          this.emitTodoPatch(session, todos);
          this.logger.info("todo list updated from TodoWrite tool", {
            runId: session.config.runId,
            nodeId: session.config.nodeId,
            todoCount: todos.length,
            isProviderWrapped: isProviderTodoWrite
          });
        } else {
          this.logger.warn("TodoWrite tool detected but failed to parse todos", {
            argsToUse
          });
        }
      }

      // For direct TodoWrite, skip execution since it's provider-internal
      if (isDirectTodoWrite) {
        this.emitToolStarted(session, tool);
        this.emitToolCompleted(session, tool.id, { ok: true, output: "Todos updated" }, undefined);
        toolQueue.shift();
        continue;
      }
      // Provider-wrapped TodoWrite continues to normal execution (already handled by provider)

      this.emitToolStarted(session, tool);
      this.logger.info("tool execution started", {
        runId: session.config.runId,
        nodeId: session.config.nodeId,
        tool: tool.name,
        toolId: tool.id
      });
      let result: ToolExecutionResult;
      try {
        result = await executeToolCall(tool, toolOptions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("tool execution failed", {
          runId: session.config.runId,
          nodeId: session.config.nodeId,
          tool: tool.name,
          toolId: tool.id,
          message
        });
        return { kind: "failed", summary: "Tool execution failed", error: message };
      }
      this.emitToolCompleted(session, tool.id, result, result.error);
      this.logger.info("tool execution completed", {
        runId: session.config.runId,
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

  private guardAgentManagementTool(session: ProviderSession, tool: ToolCall): string | null {
    if (!this.isAgentManagementTool(tool)) {
      return null;
    }
    const capabilities = session.config.capabilities;
    if (!capabilities) {
      return null;
    }
    const scope = capabilities.edgeManagement;
    if (tool.name === "spawn_node") {
      return scope === "all" ? null : "edgeManagement=all required to spawn nodes";
    }
    if (tool.name === "create_edge") {
      return scope === "none" ? "edgeManagement capability is disabled" : null;
    }
    return null;
  }

  private guardProviderNativeToolCall(session: ProviderSession, tool: ToolCall): string | null {
    if (session.config.nativeToolHandling !== "provider") {
      return null;
    }
    if (!PROVIDER_NATIVE_TOOL_NAMES.has(tool.name)) {
      return null;
    }
    return "provider-native tool_call ignored; use provider-native tools instead";
  }

  private isAgentManagementTool(tool: ToolCall): boolean {
    return tool.name === "spawn_node" || tool.name === "create_edge";
  }

  private isProviderHandledTool(config: ProviderConfig, tool: ToolCall): boolean {
    if (config.nativeToolHandling !== "provider") {
      return false;
    }
    if (tool.name !== "provider_tool") {
      return false;
    }
    const marker = tool.args.providerHandled;
    return typeof marker === "boolean" ? marker : false;
  }

  private requiresToolApproval(session: ProviderSession, tool: ToolCall): boolean {
    if (this.isProviderHandledTool(session.config, tool)) {
      return false;
    }
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
      const coreTools = this.providerResolver.getCliOptionValue(args, "--core-tools");
      const coreToolsDisabled = coreTools === "none";
      if (!coreToolsDisabled && !args.includes("--yolo")) {
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
    const spec = this.providerResolver.resolve(input.config.provider);
    if (!spec) {
      return null;
    }

    const statelessProtocol =
      spec.protocol === "raw" ||
      ((spec.protocol === "stream-json" || spec.protocol === "jsonl") && !spec.statefulStreaming);
    const requestedResume = input.config.session.resume;
    const forceResume = spec.transport === "cli" && input.config.provider === "claude";
    const resume = forceResume ? true : statelessProtocol ? false : requestedResume;
    if (forceResume && !requestedResume) {
      this.logger.warn("Claude CLI always keeps sessions alive; ignoring resume=false", {
        runId: input.run.id,
        nodeId: input.node.id,
        provider: input.config.provider
      });
    }
    if (!resume && input.config.session.resume) {
      this.logger.warn("stateless protocol disables session resume; forcing full prompts", {
        runId: input.run.id,
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
      globalMode: input.run.globalMode,
      nativeToolHandling: spec.nativeToolHandling
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
    const baseArgs = isCli ? [...(resolvedConfig.args ?? [])] : [];
    const resumeArgs = isCli ? [...(spec.resumeArgs ?? [])] : [];
    const state = new SessionStateManager({
      runId: input.run.id,
      nodeId: input.node.id,
      baseArgs,
      resumeArgs,
      replayTurns: spec.replayTurns ?? 0,
      statelessProtocol,
      logger: this.logger,
      logMeta: {
        runId: input.run.id,
        nodeId: input.node.id,
        provider: input.config.provider
      }
    });
    const session: ProviderSession = {
      adapter,
      queue,
      config: resolvedConfig,
      state
    };

    adapter.onEvent((event: EventEnvelope) => this.handleAdapterEvent(session, event));
    adapter.onError((error: Error) => {
      this.logger.error("provider adapter error", {
        runId: input.run.id,
        nodeId: input.node.id,
        message: error.message
      });
      queue.push({ type: "error", error });
    });

    try {
      await adapter.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to start provider adapter", {
        runId: input.run.id,
        nodeId: input.node.id,
        message
      });
      return null;
    }
    this.updateSessionId(input.node, session);
    this.sessions.set(input.node.id, session);
    return session;
  }

  private refreshSessionConfig(session: ProviderSession, input: TurnInput): void {
    const config = session.config;
    const nextPermissionsMode = resolvePermissionsMode(input.config.permissions.cliPermissionsMode);
    const nextEdgeManagement = input.node.capabilities.edgeManagement;
    const prevEdgeManagement = config.capabilities?.edgeManagement;
    const prevPermissionsMode = config.permissionsMode;

    config.cwd = input.run.cwd ?? this.repoRoot;
    config.globalMode = input.run.globalMode;
    config.capabilities = input.node.capabilities;
    config.permissionsMode = nextPermissionsMode;
    config.agentManagementRequiresApproval = input.node.permissions.agentManagementRequiresApproval;
    config.resetCommands = input.config.session.resetCommands;
    const requestedResume = input.config.session.resume;
    const forceResume = config.transport === "cli" && config.provider === "claude";
    if (forceResume && !requestedResume) {
      this.logger.warn("Claude CLI always keeps sessions alive; ignoring resume=false", {
        runId: input.run.id,
        nodeId: input.node.id,
        provider: input.config.provider
      });
    }
    if (session.state.isStatelessProtocol() && requestedResume) {
      this.logger.warn("stateless protocol disables session resume; keeping resume disabled", {
        runId: input.run.id,
        nodeId: input.node.id,
        provider: input.config.provider,
        protocol: session.config.transport === "cli" ? session.config.protocol : undefined
      });
    }
    config.resume = forceResume ? true : session.state.isStatelessProtocol() ? false : requestedResume;

    if (prevEdgeManagement !== undefined && prevEdgeManagement !== nextEdgeManagement) {
      this.logger.info("node capabilities updated", {
        runId: input.run.id,
        nodeId: input.node.id,
        edgeManagement: nextEdgeManagement
      });
    }
    if (prevPermissionsMode !== nextPermissionsMode) {
      this.logger.info("node permissions mode updated", {
        runId: input.run.id,
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
      const connectionStatus = event.patch.connection?.status;
      if (connectionStatus === "disconnected") {
        const canReplay = session.state.markDisconnected();
        this.logger.warn("provider session disconnected; forcing full prompt", {
          runId: session.config.runId,
          nodeId: session.config.nodeId,
          provider: session.config.provider,
          canReplay
        });
      }
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

  private parseTodoStatus(value: unknown): TodoStatus | null {
    if (value === "pending" || value === "in_progress" || value === "completed") {
      return value;
    }
    return null;
  }

  private parseTodoWriteArgs(args: Record<string, unknown>): TodoItem[] | null {
    const todosArg = args.todos;
    if (!Array.isArray(todosArg)) {
      return null;
    }
    const todos: TodoItem[] = [];
    for (const item of todosArg) {
      if (!isRecord(item)) {
        continue;
      }
      const content = item.content;
      const status = item.status;
      const activeForm = item.activeForm;
      if (typeof content !== "string" || typeof activeForm !== "string") {
        continue;
      }
      const validStatus = this.parseTodoStatus(status);
      if (!validStatus) {
        continue;
      }
      todos.push({ content, status: validStatus, activeForm });
    }
    return todos.length > 0 ? todos : null;
  }

  private emitTodoPatch(session: ProviderSession, todos: TodoItem[]): void {
    this.emitEvent(session.config.runId, {
      id: newId(),
      runId: session.config.runId,
      ts: nowIso(),
      type: "node.patch",
      nodeId: session.config.nodeId,
      patch: { todos }
    });
  }

}
