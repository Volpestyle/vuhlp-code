/**
 * Shared API client utilities for web and mobile
 *
 * Provides a factory for creating typed API clients that work
 * across platforms with consistent error handling.
 */

import type {
  ApprovalResolution,
  CreateEdgeRequest,
  CreateEdgeResponse,
  CreateNodeRequest,
  CreateNodeResponse,
  CreateRunRequest,
  CreateRunResponse,
  CreateTemplateRequest,
  CreateTemplateResponse,
  DeleteEdgeResponse,
  DeleteNodeResponse,
  DeleteRunResponse,
  DeleteTemplateResponse,
  EdgeState,
  GetArtifactResponse,
  GetRoleTemplateResponse,
  GetRunEventsResponse,
  GetRunResponse,
  ListDirectoryResponse,
  ListRunsResponse,
  ListTemplatesResponse,
  NodeCapabilities,
  NodePermissions,
  NodeSessionConfig,
  PostChatRequest,
  PostChatResponse,
  ProviderName,
  ResetNodeResponse,
  ResolveApprovalRequest,
  ResolveApprovalResponse,
  RunState,
  StartNodeProcessResponse,
  StopNodeProcessResponse,
  InterruptNodeProcessResponse,
  UpdateNodeRequest,
  UpdateNodeResponse,
  UpdateRunRequest,
  UpdateRunResponse,
  UpdateTemplateRequest,
  UpdateTemplateResponse,
} from '@vuhlp/contracts';

export interface ApiClientConfig {
  baseUrl: string;
}

export interface ApiError extends Error {
  status: number;
  statusText: string;
}

/**
 * Normalizes a base URL by removing trailing slashes
 */
export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Creates an API error with status information
 */
export function createApiError(status: number, statusText: string, message: string): ApiError {
  const error = new Error(message) as ApiError;
  error.status = status;
  error.statusText = statusText;
  return error;
}

/**
 * Generic fetch wrapper with JSON parsing and error handling
 */
export async function fetchJson<T>(
  baseUrl: string,
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = `${normalizeBaseUrl(baseUrl)}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    const message = text.length > 0 ? text : res.statusText;
    throw createApiError(res.status, res.statusText, `Request failed (${res.status}): ${message}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Node creation input type
 */
export interface CreateNodeInput {
  label: string;
  provider: ProviderName;
  roleTemplate: string;
  capabilities?: Partial<NodeCapabilities>;
  permissions?: Partial<NodePermissions>;
  session?: Partial<NodeSessionConfig>;
}

/**
 * Creates a typed API client with all endpoint methods
 */
export function createApiClient(config: ApiClientConfig) {
  const { baseUrl } = config;

  return {
    // Runs
    listRuns: async (): Promise<ListRunsResponse['runs']> => {
      const response = await fetchJson<ListRunsResponse>(baseUrl, '/api/runs');
      return response.runs;
    },

    getRun: async (runId: string): Promise<GetRunResponse['run']> => {
      const response = await fetchJson<GetRunResponse>(baseUrl, `/api/runs/${runId}`);
      return response.run;
    },

    getRunEvents: async (runId: string): Promise<GetRunEventsResponse['events']> => {
      const response = await fetchJson<GetRunEventsResponse>(baseUrl, `/api/runs/${runId}/events`);
      return response.events;
    },

    createRun: async (input?: CreateRunRequest): Promise<CreateRunResponse['run']> => {
      const body: CreateRunRequest = input ?? {};
      const response = await fetchJson<CreateRunResponse>(baseUrl, '/api/runs', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return response.run;
    },

    updateRun: async (
      runId: string,
      patch: UpdateRunRequest['patch']
    ): Promise<UpdateRunResponse['run']> => {
      const body: UpdateRunRequest = { patch };
      const response = await fetchJson<UpdateRunResponse>(baseUrl, `/api/runs/${runId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return response.run;
    },

    deleteRun: async (runId: string): Promise<DeleteRunResponse['runId']> => {
      const response = await fetchJson<DeleteRunResponse>(baseUrl, `/api/runs/${runId}`, {
        method: 'DELETE',
      });
      return response.runId;
    },

    // Nodes
    createNode: async (
      runId: string,
      node: CreateNodeInput
    ): Promise<CreateNodeResponse['node']> => {
      const body: CreateNodeRequest = { node };
      const response = await fetchJson<CreateNodeResponse>(baseUrl, `/api/runs/${runId}/nodes`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return response.node;
    },

    updateNode: async (
      runId: string,
      nodeId: string,
      patch: UpdateNodeRequest['patch'],
      nodeConfig?: UpdateNodeRequest['config']
    ): Promise<UpdateNodeResponse['node']> => {
      const body: UpdateNodeRequest = { patch, config: nodeConfig };
      const response = await fetchJson<UpdateNodeResponse>(
        baseUrl,
        `/api/runs/${runId}/nodes/${nodeId}`,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        }
      );
      return response.node;
    },

    deleteNode: async (runId: string, nodeId: string): Promise<DeleteNodeResponse['nodeId']> => {
      const response = await fetchJson<DeleteNodeResponse>(
        baseUrl,
        `/api/runs/${runId}/nodes/${nodeId}`,
        {
          method: 'DELETE',
        }
      );
      return response.nodeId;
    },

    resetNode: async (runId: string, nodeId: string): Promise<void> => {
      await fetchJson<ResetNodeResponse>(baseUrl, `/api/runs/${runId}/nodes/${nodeId}/reset`, {
        method: 'POST',
      });
    },

    startNodeProcess: async (runId: string, nodeId: string): Promise<void> => {
      await fetchJson<StartNodeProcessResponse>(
        baseUrl,
        `/api/runs/${runId}/nodes/${nodeId}/start`,
        {
          method: 'POST',
        }
      );
    },

    stopNodeProcess: async (runId: string, nodeId: string): Promise<void> => {
      await fetchJson<StopNodeProcessResponse>(
        baseUrl,
        `/api/runs/${runId}/nodes/${nodeId}/stop`,
        {
          method: 'POST',
        }
      );
    },

    interruptNodeProcess: async (runId: string, nodeId: string): Promise<void> => {
      await fetchJson<InterruptNodeProcessResponse>(
        baseUrl,
        `/api/runs/${runId}/nodes/${nodeId}/interrupt`,
        {
          method: 'POST',
        }
      );
    },

    // Edges
    createEdge: async (
      runId: string,
      edge: Omit<EdgeState, 'id'> & { id?: string }
    ): Promise<CreateEdgeResponse['edge']> => {
      const body: CreateEdgeRequest = { edge };
      const response = await fetchJson<CreateEdgeResponse>(baseUrl, `/api/runs/${runId}/edges`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return response.edge;
    },

    deleteEdge: async (runId: string, edgeId: string): Promise<DeleteEdgeResponse['edgeId']> => {
      const response = await fetchJson<DeleteEdgeResponse>(
        baseUrl,
        `/api/runs/${runId}/edges/${edgeId}`,
        {
          method: 'DELETE',
        }
      );
      return response.edgeId;
    },

    // Chat
    postChat: async (
      runId: string,
      nodeId: string,
      content: string,
      interrupt: boolean
    ): Promise<PostChatResponse['messageId']> => {
      const body: PostChatRequest = { nodeId, content, interrupt };
      const response = await fetchJson<PostChatResponse>(baseUrl, `/api/runs/${runId}/chat`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return response.messageId;
    },

    // Alias for mobile compatibility
    sendMessage: async (
      runId: string,
      nodeId: string,
      content: string,
      interrupt: boolean
    ): Promise<PostChatResponse['messageId']> => {
      const body: PostChatRequest = { nodeId, content, interrupt };
      const response = await fetchJson<PostChatResponse>(baseUrl, `/api/runs/${runId}/chat`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return response.messageId;
    },

    // Approvals
    resolveApproval: async (
      approvalId: string,
      resolution: ApprovalResolution,
      runId?: string
    ): Promise<ResolveApprovalResponse['approvalId']> => {
      const body: ResolveApprovalRequest = { resolution, runId };
      const response = await fetchJson<ResolveApprovalResponse>(
        baseUrl,
        `/api/approvals/${approvalId}/resolve`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        }
      );
      return response.approvalId;
    },

    // Artifacts
    getArtifactContent: async (
      runId: string,
      artifactId: string
    ): Promise<GetArtifactResponse> => {
      return fetchJson<GetArtifactResponse>(
        baseUrl,
        `/api/runs/${runId}/artifacts/${artifactId}`
      );
    },

    getArtifactUrl: (runId: string, artifactId: string): string =>
      `${normalizeBaseUrl(baseUrl)}/api/runs/${runId}/artifacts/${artifactId}`,

    // Templates
    listTemplates: async (): Promise<ListTemplatesResponse> => {
      return fetchJson<ListTemplatesResponse>(baseUrl, '/api/templates');
    },

    getRoleTemplate: async (name: string): Promise<GetRoleTemplateResponse> => {
      return fetchJson<GetRoleTemplateResponse>(
        baseUrl,
        `/api/templates/${encodeURIComponent(name)}`
      );
    },

    createTemplate: async (name: string, content: string): Promise<CreateTemplateResponse> => {
      const body: CreateTemplateRequest = { name, content };
      return fetchJson<CreateTemplateResponse>(baseUrl, '/api/templates', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    updateTemplate: async (name: string, content: string): Promise<UpdateTemplateResponse> => {
      const body: UpdateTemplateRequest = { content };
      return fetchJson<UpdateTemplateResponse>(
        baseUrl,
        `/api/templates/${encodeURIComponent(name)}`,
        {
          method: 'PUT',
          body: JSON.stringify(body),
        }
      );
    },

    deleteTemplate: async (name: string): Promise<DeleteTemplateResponse> => {
      return fetchJson<DeleteTemplateResponse>(
        baseUrl,
        `/api/templates/${encodeURIComponent(name)}`,
        {
          method: 'DELETE',
        }
      );
    },

    // File system
    listDirectory: async (path?: string): Promise<ListDirectoryResponse> => {
      const params = new URLSearchParams();
      if (path) params.set('path', path);
      return fetchJson<ListDirectoryResponse>(baseUrl, `/api/fs/list?${params.toString()}`);
    },
  };
}

/**
 * Returns the WebSocket URL for a given run
 */
export function getWebSocketUrl(baseUrl: string, runId: string): string {
  const wsBase = normalizeBaseUrl(baseUrl).replace(/^http/, 'ws');
  return `${wsBase}/ws?runId=${runId}`;
}

export type ApiClient = ReturnType<typeof createApiClient>;
