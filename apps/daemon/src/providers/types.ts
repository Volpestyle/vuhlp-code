import { RoleId, ToolProposal, ToolRiskLevel } from "../core/types.js";

export interface ProviderHealth {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface ProviderCapabilities {
  streaming: boolean;
  structuredOutput: boolean;
  resumableSessions: boolean;
}

export interface ProviderTask {
  runId: string;
  nodeId: string;
  role: RoleId | "verifier-helper";
  prompt: string;
  workspacePath: string;
  /**
   * Optional JSON schema (as a JSON string) describing the expected output.
   * Not all providers can enforce it; v0 uses it mainly as an instruction.
   */
  outputSchemaJson?: string;
  /** Provider-specific session ID for resuming conversations. */
  sessionId?: string;
  /** A few extra hints for adapters. */
  meta?: Record<string, unknown>;
  /** Skip provider's built-in permission system (for AUTO mode). */
  skipPermissions?: boolean;
}

/** Console stream type for raw output capture. */
export type ConsoleStreamType = "stdout" | "stderr";

/** Tool proposal from provider for approval workflow. */
export interface ProviderToolProposal {
  id: string;
  name: string;
  args: Record<string, unknown>;
  riskLevel?: ToolRiskLevel;
}

export type ProviderOutputEvent =
  // Standard events
  | { type: "progress"; message: string; raw?: unknown }
  | { type: "log"; name: string; content: string }
  | { type: "json"; name: string; json: unknown }
  | { type: "diff"; name: string; patch: string }
  | { type: "final"; output?: unknown; summary?: string }
  // Console events (raw output for terminal viewer)
  | { type: "console"; stream: ConsoleStreamType; data: string; timestamp: string }
  // Session events (for session registry)
  | { type: "session"; sessionId: string }
  // Message events (for conversation view)
  | { type: "message.delta"; delta: string; index?: number }
  | { type: "message.final"; content: string; tokenCount?: number }
  | { type: "message.reasoning"; content: string }
  // Tool events (for tool panel and approval workflow)
  | { type: "tool.proposed"; tool: ProviderToolProposal }
  | { type: "tool.started"; toolId: string }
  | { type: "tool.completed"; toolId: string; result?: unknown; error?: { message: string }; durationMs?: number };

export interface ProviderAdapter {
  id: string;
  displayName: string;
  kind: string;
  capabilities: ProviderCapabilities;

  healthCheck(): Promise<ProviderHealth>;

  runTask(task: ProviderTask, signal: AbortSignal): AsyncIterable<ProviderOutputEvent>;

  /**
   * Send an approval response for a tool call (INTERACTIVE mode only).
   * Returns true if the response was sent, false if the node is not active.
   */
  sendApprovalResponse?(
    nodeId: string,
    toolUseId: string,
    approved: boolean,
    modifiedArgs?: Record<string, unknown>
  ): boolean;
}
