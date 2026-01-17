import type {
  ApprovalResolution,
  CreateNodeRequest,
  CreateNodeResponse,
  CreateEdgeRequest,
  CreateEdgeResponse,
  CreateRunRequest,
  CreateRunResponse,
  DeleteRunResponse,
  DeleteNodeResponse,
  DeleteEdgeResponse,
  GetArtifactResponse,
  GetRunResponse,
  ListRunsResponse,
  PostChatRequest,
  PostChatResponse,
  ResolveApprovalRequest,
  ResolveApprovalResponse,
  ResetNodeResponse,
  UpdateNodeRequest,
  UpdateNodeResponse,
  UpdateRunRequest,
  UpdateRunResponse
} from "@vuhlp/contracts";

const DEFAULT_API_URL = "http://localhost:4000";

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function getApiBaseUrl(): string {
  const envUrl = import.meta.env.VITE_API_URL as string | undefined;
  return normalizeBaseUrl(envUrl ?? DEFAULT_API_URL);
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${getApiBaseUrl()}${path}`;
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    const message = text.length > 0 ? text : res.statusText;
    throw new Error(`Request failed (${res.status}): ${message}`);
  }
  return (await res.json()) as T;
}

export async function createRun(input?: CreateRunRequest): Promise<CreateRunResponse["run"]> {
  const body: CreateRunRequest = input ?? {};
  const response = await fetchJson<CreateRunResponse>("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.run;
}

export async function listRuns(): Promise<ListRunsResponse["runs"]> {
  const response = await fetchJson<ListRunsResponse>("/api/runs");
  return response.runs;
}

export async function getRun(runId: string): Promise<GetRunResponse["run"]> {
  const response = await fetchJson<GetRunResponse>(`/api/runs/${runId}`);
  return response.run;
}

export async function deleteRun(runId: string): Promise<DeleteRunResponse["runId"]> {
  const response = await fetchJson<DeleteRunResponse>(`/api/runs/${runId}`, {
    method: "DELETE"
  });
  return response.runId;
}

export async function updateRun(runId: string, patch: UpdateRunRequest["patch"]): Promise<UpdateRunResponse["run"]> {
  const body: UpdateRunRequest = { patch };
  const response = await fetchJson<UpdateRunResponse>(`/api/runs/${runId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.run;
}

export async function createNode(runId: string, node: CreateNodeRequest["node"]): Promise<CreateNodeResponse["node"]> {
  const body: CreateNodeRequest = { node };
  const response = await fetchJson<CreateNodeResponse>(`/api/runs/${runId}/nodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.node;
}

export async function createEdge(runId: string, edge: CreateEdgeRequest["edge"]): Promise<CreateEdgeResponse["edge"]> {
  const body: CreateEdgeRequest = { edge };
  const response = await fetchJson<CreateEdgeResponse>(`/api/runs/${runId}/edges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.edge;
}

export async function updateNode(
  runId: string,
  nodeId: string,
  patch: UpdateNodeRequest["patch"],
  config?: UpdateNodeRequest["config"]
): Promise<UpdateNodeResponse["node"]> {
  const body: UpdateNodeRequest = { patch, config };
  const response = await fetchJson<UpdateNodeResponse>(`/api/runs/${runId}/nodes/${nodeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.node;
}

export async function deleteNode(runId: string, nodeId: string): Promise<DeleteNodeResponse["nodeId"]> {
  const response = await fetchJson<DeleteNodeResponse>(`/api/runs/${runId}/nodes/${nodeId}`, {
    method: "DELETE"
  });
  return response.nodeId;
}

export async function deleteEdge(runId: string, edgeId: string): Promise<DeleteEdgeResponse["edgeId"]> {
  const response = await fetchJson<DeleteEdgeResponse>(`/api/runs/${runId}/edges/${edgeId}`, {
    method: "DELETE"
  });
  return response.edgeId;
}

export async function postChat(
  runId: string,
  nodeId: string,
  content: string,
  interrupt: boolean
): Promise<PostChatResponse["messageId"]> {
  const body: PostChatRequest = { nodeId, content, interrupt };
  const response = await fetchJson<PostChatResponse>(`/api/runs/${runId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.messageId;
}

export async function resetNode(runId: string, nodeId: string): Promise<void> {
  await fetchJson<ResetNodeResponse>(`/api/runs/${runId}/nodes/${nodeId}/reset`, {
    method: "POST"
  });
}

export async function getArtifactContent(runId: string, artifactId: string): Promise<GetArtifactResponse> {
  return fetchJson<GetArtifactResponse>(`/api/runs/${runId}/artifacts/${artifactId}`);
}

export async function resolveApproval(
  approvalId: string,
  resolution: ApprovalResolution,
  runId?: string
): Promise<ResolveApprovalResponse["approvalId"]> {
  const body: ResolveApprovalRequest = { resolution, runId };
  const response = await fetchJson<ResolveApprovalResponse>(`/api/approvals/${approvalId}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.approvalId;
}
