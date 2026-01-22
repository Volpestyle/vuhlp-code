import type {
  ApprovalResolution,
  CreateNodeRequest,
  CreateEdgeRequest,
  CreateRunRequest,
  UpdateRunRequest,
  UpdateNodeRequest,
} from "@vuhlp/contracts";
import {
  createApiClient,
  normalizeBaseUrl,
} from "@vuhlp/shared";

const DEFAULT_API_URL = "";

function getApiBaseUrl(): string {
  const envUrl = import.meta.env.VITE_API_URL;
  if (typeof envUrl === "string" && envUrl.trim().length > 0) {
    return normalizeBaseUrl(envUrl);
  }
  return normalizeBaseUrl(DEFAULT_API_URL);
}

const client = createApiClient({ baseUrl: getApiBaseUrl() });

// Re-export all client methods as named exports for backwards compatibility
export const listRuns = client.listRuns;
export const getRun = client.getRun;
export const getRunEvents = client.getRunEvents;
export const deleteRun = client.deleteRun;
export const deleteNode = client.deleteNode;
export const deleteEdge = client.deleteEdge;
export const postChat = client.postChat;
export const resetNode = client.resetNode;
export const startNodeProcess = client.startNodeProcess;
export const stopNodeProcess = client.stopNodeProcess;
export const interruptNodeProcess = client.interruptNodeProcess;
export const getArtifactContent = client.getArtifactContent;
export const getRoleTemplate = client.getRoleTemplate;
export const listTemplates = client.listTemplates;
export const createTemplate = client.createTemplate;
export const updateTemplate = client.updateTemplate;
export const deleteTemplate = client.deleteTemplate;
export const listDirectory = client.listDirectory;

// Functions with slightly different signatures need wrappers to maintain backwards compatibility
export async function createRun(input?: CreateRunRequest) {
  return client.createRun(input);
}

export async function updateRun(runId: string, patch: UpdateRunRequest["patch"]) {
  return client.updateRun(runId, patch);
}

export async function createNode(runId: string, node: CreateNodeRequest["node"]) {
  return client.createNode(runId, node);
}

export async function createEdge(runId: string, edge: CreateEdgeRequest["edge"]) {
  return client.createEdge(runId, edge);
}

export async function updateNode(
  runId: string,
  nodeId: string,
  patch: UpdateNodeRequest["patch"],
  config?: UpdateNodeRequest["config"]
) {
  return client.updateNode(runId, nodeId, patch, config);
}

export async function resolveApproval(
  approvalId: string,
  resolution: ApprovalResolution,
  runId?: string
) {
  return client.resolveApproval(approvalId, resolution, runId);
}
