import type { ToolKind } from "./tools";

export interface VerifyPolicy {
  autoVerify: boolean;
  commands: string[];
  requireClean: boolean;
}

export interface ApprovalPolicy {
  requireForKinds: ToolKind[];
  requireForTools: string[];
}

export interface PatchReviewPolicy {
  mode: string;
}

export function defaultVerifyPolicy(): VerifyPolicy {
  return { autoVerify: true, commands: ["make test"], requireClean: false };
}

export function defaultApprovalPolicy(): ApprovalPolicy {
  return { requireForKinds: ["exec", "write"], requireForTools: [] };
}
