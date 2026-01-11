import { RoleId } from "../core/types.js";

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
  /** A few extra hints for adapters. */
  meta?: Record<string, unknown>;
}

export type ProviderOutputEvent =
  | { type: "progress"; message: string; raw?: unknown }
  | { type: "log"; name: string; content: string }
  | { type: "json"; name: string; json: unknown }
  | { type: "diff"; name: string; patch: string }
  | { type: "final"; output?: unknown; summary?: string };

export interface ProviderAdapter {
  id: string;
  displayName: string;
  kind: string;
  capabilities: ProviderCapabilities;

  healthCheck(): Promise<ProviderHealth>;

  runTask(task: ProviderTask, signal: AbortSignal): AsyncIterable<ProviderOutputEvent>;
}
