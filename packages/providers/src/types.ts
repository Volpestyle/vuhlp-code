import type { ApprovalResolution, CliPermissionsMode, EventEnvelope, ProviderName, UUID } from "@vuhlp/contracts";

export type PromptKind = "full" | "delta";

export interface ProviderTurnInput {
  prompt: string;
  promptKind: PromptKind;
  turnId?: UUID;
}

export type ProviderProtocol = "jsonl" | "raw";

export interface CliProviderConfig {
  runId: UUID;
  nodeId: UUID;
  provider: ProviderName;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  permissionsMode: CliPermissionsMode;
  resume: boolean;
  resetCommands: string[];
  protocol: ProviderProtocol;
}

export type ProviderEventListener = (event: EventEnvelope) => void;
export type ProviderErrorListener = (error: Error) => void;

export interface ProviderAdapter {
  start(): Promise<void>;
  send(input: ProviderTurnInput): Promise<void>;
  resolveApproval(approvalId: UUID, resolution: ApprovalResolution): Promise<void>;
  resetSession(): Promise<void>;
  close(): Promise<void>;
  getSessionId(): string | null;
  onEvent(listener: ProviderEventListener): () => void;
  onError(listener: ProviderErrorListener): () => void;
}
