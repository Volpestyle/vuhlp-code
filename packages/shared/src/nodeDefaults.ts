import type { EdgeManagementScope, NodeCapabilities, NodePermissions, ProviderName } from "@vuhlp/contracts";

export const PROVIDER_OPTIONS: ProviderName[] = ["claude", "codex", "gemini", "custom"];
export const PERMISSIONS_MODE_OPTIONS: Array<NodePermissions["cliPermissionsMode"]> = [
  "skip",
  "gated",
];
export const ORCHESTRATOR_ROLE = "orchestrator";
export const ROLE_TEMPLATES = [
  "implementer",
  ORCHESTRATOR_ROLE,
  "investigator",
  "planner",
  "reviewer",
];

export const DEFAULT_CAPABILITIES: NodeCapabilities = {
  edgeManagement: "none",
  writeCode: true,
  writeDocs: true,
  runCommands: true,
  delegateOnly: false,
};

export const DEFAULT_PERMISSIONS: NodePermissions = {
  cliPermissionsMode: "skip",
  agentManagementRequiresApproval: true,
};

export const EDGE_MANAGEMENT_OPTIONS: EdgeManagementScope[] = ["none", "self", "all"];

export function parseEdgeManagement(value: string): EdgeManagementScope | null {
  for (const option of EDGE_MANAGEMENT_OPTIONS) {
    if (option === value) {
      return option;
    }
  }
  return null;
}

export function getEdgeManagementDefaults(roleTemplate: string): {
  edgeManagement: EdgeManagementScope;
  agentManagementRequiresApproval: boolean;
} {
  const isOrchestrator = roleTemplate.trim().toLowerCase() === ORCHESTRATOR_ROLE;
  return {
    edgeManagement: isOrchestrator ? "all" : "none",
    agentManagementRequiresApproval: !isOrchestrator,
  };
}

export function parseProviderName(value: string): ProviderName | null {
  for (const option of PROVIDER_OPTIONS) {
    if (option === value) {
      return option;
    }
  }
  return null;
}

export function parsePermissionsMode(
  value: string
): NodePermissions["cliPermissionsMode"] | null {
  for (const mode of PERMISSIONS_MODE_OPTIONS) {
    if (mode === value) {
      return mode;
    }
  }
  return null;
}
