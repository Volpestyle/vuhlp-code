import type {
  CreateEdgeResponse,
  CreateNodeResponse,
  DeleteEdgeResponse,
  DeleteNodeResponse,
  EdgeState,
  GetRunResponse,
  ListRunsResponse,
  PostChatResponse,
  ResetNodeResponse,
  ResolveApprovalResponse,
  RunState,
  UpdateNodeResponse,
  UpdateRunResponse,
} from '@vuhlp/contracts';

// Configure this via environment or settings screen
const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  // Runs
  listRuns: async () => {
    const { runs } = await request<ListRunsResponse>('/api/runs');
    return runs;
  },

  getRun: async (runId: string) => {
    const { run } = await request<GetRunResponse>(`/api/runs/${runId}`);
    return run;
  },

  updateRun: async (runId: string, patch: Partial<RunState>) => {
    const { run } = await request<UpdateRunResponse>(`/api/runs/${runId}`, {
      method: 'PATCH',
      body: JSON.stringify({ patch }),
    });
    return run;
  },

  // Nodes
  createNode: async (runId: string, node: { label: string; provider: string; roleTemplate: string }) => {
    const { node: createdNode } = await request<CreateNodeResponse>(`/api/runs/${runId}/nodes`, {
      method: 'POST',
      body: JSON.stringify({ node }),
    });
    return createdNode;
  },

  updateNode: async (
    runId: string,
    nodeId: string,
    patch: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => {
    const { node } = await request<UpdateNodeResponse>(`/api/runs/${runId}/nodes/${nodeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ patch, config }),
    });
    return node;
  },

  deleteNode: async (runId: string, nodeId: string) => {
    const { nodeId: deletedNodeId } = await request<DeleteNodeResponse>(
      `/api/runs/${runId}/nodes/${nodeId}`,
      {
        method: 'DELETE',
      }
    );
    return deletedNodeId;
  },

  resetNode: async (runId: string, nodeId: string) => {
    const { ok } = await request<ResetNodeResponse>(`/api/runs/${runId}/nodes/${nodeId}/reset`, {
      method: 'POST',
    });
    return ok;
  },

  // Edges
  createEdge: async (runId: string, edge: Omit<EdgeState, 'id'> & { id?: string }) => {
    const { edge: createdEdge } = await request<CreateEdgeResponse>(`/api/runs/${runId}/edges`, {
      method: 'POST',
      body: JSON.stringify({ edge }),
    });
    return createdEdge;
  },

  deleteEdge: async (runId: string, edgeId: string) => {
    const { edgeId: deletedEdgeId } = await request<DeleteEdgeResponse>(
      `/api/runs/${runId}/edges/${edgeId}`,
      {
        method: 'DELETE',
      }
    );
    return deletedEdgeId;
  },

  // Chat
  sendMessage: async (runId: string, nodeId: string, message: string, interrupt: boolean) => {
    const { messageId } = await request<PostChatResponse>(`/api/runs/${runId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ nodeId, content: message, interrupt }),
    });
    return messageId;
  },

  // Approvals
  resolveApproval: async (
    approvalId: string,
    resolution: { status: 'approved' | 'denied'; reason?: string }
  ) => {
    const { approvalId: resolvedId } = await request<ResolveApprovalResponse>(
      `/api/approvals/${approvalId}/resolve`,
      {
        method: 'POST',
        body: JSON.stringify({ resolution }),
      }
    );
    return resolvedId;
  },

  // Artifacts
  getArtifactUrl: (runId: string, artifactId: string) =>
    `${API_BASE}/api/runs/${runId}/artifacts/${artifactId}`,
};

export function getWebSocketUrl(runId: string): string {
  const wsBase = API_BASE.replace(/^http/, 'ws');
  return `${wsBase}/ws?runId=${runId}`;
}
