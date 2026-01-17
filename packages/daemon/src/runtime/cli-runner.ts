import type {
  ApprovalRequest,
  ApprovalResolution,
  EventEnvelope,
  NodeState,
  PromptArtifacts,
  ProviderName,
  UUID
} from "@vuhlp/contracts";
import {
  CliProviderAdapter,
  ConsoleLogger,
  resolvePermissionsMode,
  type CliProviderConfig,
  type Logger,
  type ProviderProtocol
} from "@vuhlp/providers";
import { AsyncQueue } from "./async-queue.js";
import { PromptBuilder } from "./prompt-builder.js";
import type { NodeRunner, TurnInput, TurnResult } from "./runner.js";
import { newId, nowIso } from "./utils.js";

interface ProviderSpec {
  command: string;
  args: string[];
  protocol: ProviderProtocol;
}

interface PendingTurn {
  promptArtifacts: PromptArtifacts;
  partialOutput: string;
  promptLogged: boolean;
}

interface ProviderSession {
  adapter: CliProviderAdapter;
  queue: AsyncQueue<TurnSignal>;
  config: CliProviderConfig;
  promptSent: boolean;
  pendingTurn?: PendingTurn;
  sessionId?: string;
}

type TurnSignal =
  | { type: "message.assistant.delta"; delta: string }
  | { type: "message.assistant.final"; content: string }
  | { type: "approval.requested"; approval: ApprovalRequest }
  | { type: "error"; error: Error };

export interface CliRunnerOptions {
  repoRoot: string;
  emitEvent: (runId: UUID, event: EventEnvelope) => void;
  logger?: Logger;
}

export class CliRunner implements NodeRunner {
  private readonly sessions = new Map<UUID, ProviderSession>();
  private readonly pendingApprovals = new Map<UUID, UUID>();
  private readonly promptBuilder: PromptBuilder;
  private readonly emitEvent: (runId: UUID, event: EventEnvelope) => void;
  private readonly logger: Logger;
  private readonly repoRoot: string;

  constructor(options: CliRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.emitEvent = options.emitEvent;
    this.logger = options.logger ?? new ConsoleLogger();
    this.promptBuilder = new PromptBuilder(this.repoRoot);
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

    const prompt = await this.promptBuilder.build(input);
    const promptKind = this.resolvePromptKind(session, input.config.session.resume);
    const promptPayload = promptKind === "full" ? prompt.artifacts.full : prompt.delta;

    try {
      await session.adapter.send({
        prompt: promptPayload,
        promptKind,
        turnId: newId()
      });
      this.updateSessionId(input.node, session);
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
      promptLogged: false
    };

    const outcome = await this.waitForOutcome(session, turnState);
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

    if (outcome.kind === "failed") {
      return {
        kind: "failed",
        summary: outcome.summary,
        error: outcome.error,
        prompt: prompt.artifacts
      };
    }

    return {
      kind: "completed",
      summary: outcome.summary,
      message: outcome.message,
      prompt: prompt.artifacts
    };
  }

  async resolveApproval(approvalId: UUID, resolution: ApprovalResolution): Promise<void> {
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

  private resolvePromptKind(session: ProviderSession, resume: boolean): "full" | "delta" {
    if (!resume) {
      return "full";
    }
    return session.promptSent ? "delta" : "full";
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

    const outcome = await this.waitForOutcome(session, pending);
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
        const summary = this.summarize(message);
        return { kind: "completed", message, summary };
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

  private async ensureSession(input: TurnInput): Promise<ProviderSession | null> {
    const existing = this.sessions.get(input.node.id);
    if (existing) {
      return existing;
    }
    const spec = this.resolveProviderSpec(input.config.provider);
    if (!spec) {
      return null;
    }

    const config: CliProviderConfig = {
      runId: input.run.id,
      nodeId: input.node.id,
      provider: input.config.provider,
      command: spec.command,
      args: spec.args,
      cwd: this.repoRoot,
      permissionsMode: resolvePermissionsMode(input.config.permissions.cliPermissionsMode),
      resume: input.config.session.resume,
      resetCommands: input.config.session.resetCommands,
      protocol: spec.protocol
    };

    const adapter = new CliProviderAdapter(config, this.logger);
    const queue = new AsyncQueue<TurnSignal>();
    const session: ProviderSession = {
      adapter,
      queue,
      config,
      promptSent: false
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
      this.emitEvent(event.runId, event);
      session.queue.push({ type: "message.assistant.delta", delta: event.delta });
      return;
    }
    if (event.type === "message.assistant.final") {
      session.queue.push({ type: "message.assistant.final", content: event.content });
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
    const explicitCommand = this.readEnv(`VUHLP_${prefix}_COMMAND`);
    const command = explicitCommand ?? provider;
    const args = this.parseArgs(this.readEnv(`VUHLP_${prefix}_ARGS`));
    const protocol = this.parseProtocol(this.readEnv(`VUHLP_${prefix}_PROTOCOL`));
    if (provider === "custom" && !explicitCommand) {
      return null;
    }
    return { command, args, protocol };
  }

  private readEnv(name: string): string | undefined {
    const value = process.env[name];
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private parseArgs(raw?: string): string[] {
    if (!raw) {
      return [];
    }
    return raw.split(/\s+/).filter((value) => value.length > 0);
  }

  private parseProtocol(raw?: string): ProviderProtocol {
    return raw === "raw" ? "raw" : "jsonl";
  }
}
