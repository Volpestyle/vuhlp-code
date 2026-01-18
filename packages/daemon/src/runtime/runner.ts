import type {
  ApprovalRequest,
  ApprovalResolution,
  ArtifactKind,
  Envelope,
  NodeConfig,
  NodeState,
  PromptArtifacts,
  ProviderName,
  RunState,
  UserMessageRecord,
  UUID
} from "@vuhlp/contracts";

export interface TurnInput {
  run: RunState;
  node: NodeState;
  config: NodeConfig;
  envelopes: Envelope[];
  messages: UserMessageRecord[];
}

export interface TurnDiff {
  content: string;
  filesChanged?: string[];
  summary?: string;
}

export interface TurnArtifact {
  kind: ArtifactKind;
  name: string;
  content: string;
  metadata?: {
    filesChanged?: string[];
    summary?: string;
  };
}

export type TurnResult =
  | {
      kind: "completed";
      summary: string;
      message: string;
      outgoing?: Envelope[];
      artifacts?: TurnArtifact[];
      diff?: TurnDiff;
      outputHash?: string;
      diffHash?: string;
      verificationFailure?: string;
      prompt?: PromptArtifacts;
    }
  | {
      kind: "interrupted";
      summary: string;
      message?: string;
      prompt?: PromptArtifacts;
    }
  | {
      kind: "blocked";
      summary: string;
      approval: ApprovalRequest;
      prompt?: PromptArtifacts;
    }
  | {
      kind: "failed";
      summary: string;
      error: string;
      prompt?: PromptArtifacts;
    };

export interface NodeRunner {
  supports(provider: ProviderName): boolean;
  runTurn(input: TurnInput): Promise<TurnResult>;
  resolveApproval?(approvalId: UUID, resolution: ApprovalResolution): Promise<void>;
  resetNode?(nodeId: UUID): Promise<void>;
  closeNode?(nodeId: UUID): Promise<void>;
  interruptNode?(nodeId: UUID): Promise<void>;
}

export class NoopRunner implements NodeRunner {
  supports(_provider: ProviderName): boolean {
    return true;
  }

  async runTurn(_input: TurnInput): Promise<TurnResult> {
    return {
      kind: "failed",
      summary: "No provider adapter registered",
      error: "No provider adapter registered"
    };
  }
}
