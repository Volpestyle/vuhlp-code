import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  ApprovalRequest,
  Artifact,
  DaemonState,
  Edge,
  MessageEvent,
  NodeTrackedState,
  PendingPrompt,
  ToolEvent,
  ToolRiskLevel,
} from '@vuhlp/ui';
import { httpGet, httpPost, httpPatch, httpDelete } from './api';

// Chat types
export type InteractionMode = 'autonomous' | 'interactive';

// Run mode types (AUTO/INTERACTIVE orchestration)
export type RunMode = 'AUTO' | 'INTERACTIVE';

// Run phase types
export type RunPhase =
  | 'BOOT'
  | 'DOCS_ITERATION'
  | 'INVESTIGATE'
  | 'PLAN'
  | 'EXECUTE'
  | 'VERIFY'
  | 'DOCS_SYNC'
  | 'DONE';

export interface ChatMessage {
  id: string;
  runId: string;
  nodeId?: string;
  role: 'user' | 'system';
  content: string;
  createdAt: string;
  processed: boolean;
  interruptedExecution: boolean;
}

interface ExtendedDaemonState extends DaemonState {
  chatMessages: Record<string, ChatMessage[]>; // runId -> messages
  interactionModes: Record<string, InteractionMode>; // "runId" or "runId:nodeId" -> mode
  promptQueue: Record<string, PendingPrompt[]>; // runId -> pending prompts
}

function createEmptyTrackedState(): NodeTrackedState {
  return {
    messages: [],
    tools: [],
    consoleChunks: [],
    events: [],
  };
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// Map daemon's EdgeRecord (from/to) to UI's Edge (source/target)
function mapEdges(edges: Record<string, unknown> | undefined): Record<string, Edge> {
  if (!edges) return {};
  const result: Record<string, Edge> = {};
  for (const [id, rawEdge] of Object.entries(edges)) {
    const e = rawEdge as { id: string; from?: string; to?: string; source?: string; target?: string; type: string; label?: string };
    result[id] = {
      id: e.id,
      source: e.source ?? e.from ?? '',
      target: e.target ?? e.to ?? '',
      type: e.type as Edge['type'],
      label: e.label,
    };
  }
  return result;
}

export function useDaemon() {
  const [state, setState] = useState<ExtendedDaemonState>({
    runs: {},
    nodeLogs: {},
    nodeTrackedState: {},
    providers: [],
    connStatus: 'connecting...',
    pendingApprovals: [],
    pendingPrompts: [],
    chatMessages: {},
    interactionModes: {},
    promptQueue: {},
  });

  const [isLoadingRuns, setIsLoadingRuns] = useState(true);
  const [isLoadingProviders, setIsLoadingProviders] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      setIsLoadingProviders(true);
      const data = await httpGet('/api/providers');
      setState((s) => ({ ...s, providers: data.providers || [] }));
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingProviders(false);
    }
  }, []);

  const fetchRuns = useCallback(async (includeArchived: boolean = false) => {
    try {
      setIsLoadingRuns(true);
      const url = includeArchived ? '/api/runs?includeArchived=true' : '/api/runs';
      const data = await httpGet(url);
      setState((s) => {
        const nextRuns = { ...s.runs };
        for (const r of data.runs || []) {
          const mapped = { ...nextRuns[r.id], ...r };
          // Map edges from daemon format (from/to) to UI format (source/target)
          if (r.edges) {
            mapped.edges = mapEdges(r.edges as Record<string, unknown>);
          }
          nextRuns[r.id] = mapped;
        }
        return { ...s, runs: nextRuns };
      });
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingRuns(false);
    }
  }, []);

  const fetchPendingApprovals = useCallback(async () => {
    try {
      const data = await httpGet('/api/approvals');
      setState((s) => ({ ...s, pendingApprovals: data.approvals || [] }));
    } catch (e) {
      console.error(e);
    }
  }, []);

  const getConfig = useCallback(async () => {
    return await httpGet('/api/config');
  }, []);

  const saveConfig = useCallback(async (updates: Record<string, unknown>) => {
    return await httpPost('/api/config', updates);
  }, []);

  const createRun = useCallback(async (prompt: string, repoPath: string) => {
    const data = await httpPost('/api/runs', { prompt, repoPath });
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', runId: data.runId }));
    }
    return data.runId;
  }, []);

  const stopRun = useCallback(async (runId: string) => {
    await httpPost(`/api/runs/${runId}/stop`, {});
  }, []);

  const deleteRun = useCallback(async (runId: string) => {
    await httpDelete(`/api/runs/${runId}`);
    // Remove locally immediately to feel snappy
    setState((s) => {
      const nextRuns = { ...s.runs };
      delete nextRuns[runId];
      return { ...s, runs: nextRuns };
    });
  }, []);

  const archiveRun = useCallback(async (runId: string) => {
    const data = await httpPost(`/api/runs/${runId}/archive`, {});
    // Update locally immediately to feel snappy
    setState((s) => {
      const run = s.runs[runId];
      if (!run) return s;
      return {
        ...s,
        runs: {
          ...s.runs,
          [runId]: { ...run, archived: true, archivedAt: new Date().toISOString() },
        },
      };
    });
    return data.run;
  }, []);

  const unarchiveRun = useCallback(async (runId: string) => {
    const data = await httpPost(`/api/runs/${runId}/unarchive`, {});
    // Update locally immediately to feel snappy
    setState((s) => {
      const run = s.runs[runId];
      if (!run) return s;
      return {
        ...s,
        runs: {
          ...s.runs,
          [runId]: { ...run, archived: false, archivedAt: undefined },
        },
      };
    });
    return data.run;
  }, []);

  const renameRun = useCallback(async (runId: string, name: string) => {
    const data = await httpPatch(`/api/runs/${runId}`, { name });
    // Update locally immediately to feel snappy
    setState((s) => {
      const run = s.runs[runId];
      if (!run) return s;
      return {
        ...s,
        runs: {
          ...s.runs,
          [runId]: { ...run, name: name.trim() || undefined },
        },
      };
    });
    return data.run;
  }, []);

  const pauseRun = useCallback(async (runId: string) => {
    await httpPost(`/api/runs/${runId}/pause`, {});
  }, []);

  const resumeRun = useCallback(async (runId: string, feedback?: string) => {
    await httpPost(`/api/runs/${runId}/resume`, { feedback });
  }, []);

  // Approval actions
  const approveRequest = useCallback(async (approvalId: string, feedback?: string) => {
    await httpPost(`/api/approvals/${approvalId}/approve`, { feedback });
    await fetchPendingApprovals();
  }, [fetchPendingApprovals]);

  const denyRequest = useCallback(async (approvalId: string, feedback?: string) => {
    await httpPost(`/api/approvals/${approvalId}/deny`, { feedback });
    await fetchPendingApprovals();
  }, [fetchPendingApprovals]);

  const modifyRequest = useCallback(async (
    approvalId: string,
    modifiedArgs: Record<string, unknown>,
    feedback?: string
  ) => {
    await httpPost(`/api/approvals/${approvalId}/modify`, { modifiedArgs, feedback });
    await fetchPendingApprovals();
  }, [fetchPendingApprovals]);

  // Chat methods
  const sendChatMessage = useCallback(
    async (
      runId: string,
      content: string,
      options?: { nodeId?: string; interrupt?: boolean }
    ) => {
      await httpPost(`/api/runs/${runId}/chat`, {
        content,
        nodeId: options?.nodeId,
        interrupt: options?.interrupt ?? true,
      });
    },
    []
  );

  const queueChatMessage = useCallback(
    async (runId: string, content: string, nodeId?: string) => {
      await httpPost(`/api/runs/${runId}/chat`, {
        content,
        nodeId,
        interrupt: false,
      });
    },
    []
  );

  const setInteractionMode = useCallback(
    async (runId: string, mode: InteractionMode, nodeId?: string) => {
      await httpPost(`/api/runs/${runId}/mode`, { mode, nodeId });
    },
    []
  );

  const getInteractionMode = useCallback(
    (runId: string, nodeId?: string): InteractionMode => {
      const key = nodeId ? `${runId}:${nodeId}` : runId;
      return state.interactionModes[key] ?? 'autonomous';
    },
    [state.interactionModes]
  );

  // Run mode methods (AUTO/INTERACTIVE orchestration control)
  const setRunMode = useCallback(
    async (runId: string, mode: RunMode) => {
      await httpPost(`/api/runs/${runId}/run-mode`, { mode });
    },
    []
  );

  const getRunMode = useCallback(
    (runId: string): RunMode => {
      const run = state.runs[runId];
      return (run?.mode as RunMode) ?? 'AUTO';
    },
    [state.runs]
  );

  const getRunPhase = useCallback(
    (runId: string): RunPhase | null => {
      const run = state.runs[runId];
      return (run?.phase as RunPhase) ?? null;
    },
    [state.runs]
  );

  const getChatMessages = useCallback(
    (runId: string, nodeId?: string): ChatMessage[] => {
      const allMessages = state.chatMessages[runId] ?? [];
      if (nodeId !== undefined) {
        return allMessages.filter(
          (msg) => msg.nodeId === nodeId || msg.nodeId === undefined
        );
      }
      return allMessages;
    },
    [state.chatMessages]
  );

  // Prompt queue methods (Section 3.4)
  const fetchPrompts = useCallback(async (runId: string) => {
    try {
      const data = await httpGet(`/api/runs/${runId}/prompts`);
      setState((s) => ({
        ...s,
        promptQueue: {
          ...s.promptQueue,
          [runId]: data.prompts || [],
        },
      }));
      return data;
    } catch (e) {
      console.error('Failed to fetch prompts:', e);
      return null;
    }
  }, []);

  const getPrompts = useCallback(
    (runId: string): PendingPrompt[] => {
      return state.promptQueue[runId] ?? [];
    },
    [state.promptQueue]
  );

  const getPendingPrompts = useCallback(
    (runId: string): PendingPrompt[] => {
      return (state.promptQueue[runId] ?? []).filter((p) => p.status === 'pending');
    },
    [state.promptQueue]
  );

  const sendPrompt = useCallback(
    async (runId: string, promptId: string) => {
      try {
        const result = await httpPost(`/api/runs/${runId}/prompts/${promptId}/send`, {});
        // Refresh prompts after sending
        await fetchPrompts(runId);
        return result;
      } catch (e) {
        console.error('Failed to send prompt:', e);
        throw e;
      }
    },
    [fetchPrompts]
  );

  const cancelPrompt = useCallback(
    async (runId: string, promptId: string, reason?: string) => {
      try {
        await httpPost(`/api/runs/${runId}/prompts/${promptId}/cancel`, { reason });
        // Refresh prompts after cancelling
        await fetchPrompts(runId);
      } catch (e) {
        console.error('Failed to cancel prompt:', e);
        throw e;
      }
    },
    [fetchPrompts]
  );

  const modifyPrompt = useCallback(
    async (runId: string, promptId: string, content: string) => {
      try {
        await httpPatch(`/api/runs/${runId}/prompts/${promptId}`, { content });
        // Refresh prompts after modifying
        await fetchPrompts(runId);
      } catch (e) {
        console.error('Failed to modify prompt:', e);
        throw e;
      }
    },
    [fetchPrompts]
  );

  const addUserPrompt = useCallback(
    async (runId: string, content: string, targetNodeId?: string) => {
      try {
        const result = await httpPost(`/api/runs/${runId}/prompts`, {
          content,
          targetNodeId,
        });
        // Refresh prompts after adding
        await fetchPrompts(runId);
        return result.prompt as PendingPrompt;
      } catch (e) {
        console.error('Failed to add user prompt:', e);
        throw e;
      }
    },
    [fetchPrompts]
  );

  const connectWs = useCallback(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setState((s) => ({ ...s, connStatus: 'connected' }));
      ws.send(JSON.stringify({ type: 'subscribe', runId: '*' }));
      // Fetch fresh state on reconnect to catch any missed events
      fetchRuns();
      fetchPendingApprovals();
    };

    ws.onclose = () => {
      setState((s) => ({ ...s, connStatus: 'disconnected (retrying)' }));
      setTimeout(connectWs, 1200);
    };

    ws.onerror = () => {
      setState((s) => ({ ...s, connStatus: 'error' }));
    };

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      handleMessage(msg);
    };
  }, [fetchRuns, fetchPendingApprovals]);

  const handleMessage = (msg: Record<string, unknown>) => {
    if (msg.type === 'hello') {
      const runs = msg.runs as Array<Record<string, unknown>> | undefined;
      setState((s) => {
        const nextRuns = { ...s.runs };
        for (const r of runs || []) {
          const id = r.id as string;
          const mapped = { ...(nextRuns[id] || {}), ...r } as DaemonState['runs'][string];
          // Map edges from daemon format (from/to) to UI format (source/target)
          if (r.edges) {
            mapped.edges = mapEdges(r.edges as Record<string, unknown>);
          }
          nextRuns[id] = mapped;
        }
        return { ...s, connStatus: 'connected', runs: nextRuns };
      });
    } else if (msg.type === 'snapshot') {
      const run = msg.run as DaemonState['runs'][string] & { edges?: Record<string, unknown> };
      // Map edges from daemon format (from/to) to UI format (source/target)
      const mappedRun = { ...run };
      if (run.edges) {
        mappedRun.edges = mapEdges(run.edges);
      }
      setState((s) => ({
        ...s,
        runs: { ...s.runs, [mappedRun.id]: mappedRun },
      }));
    } else if (msg.type === 'event') {
      applyEvent(msg.event as Record<string, unknown>);
    }
  };

  const applyEvent = (ev: Record<string, unknown>) => {
    setState((s) => {
      const runId = ev.runId as string;
      const run = s.runs[runId];
      if (!run) return s;

      const nextRun = { ...run };
      const nextNodeLogs = { ...s.nodeLogs };
      const nextTrackedState = { ...s.nodeTrackedState };
      let nextApprovals = [...s.pendingApprovals];

      const evType = ev.type as string;
      const nodeId = ev.nodeId as string | undefined;
      const ts = (ev.ts as string) || new Date().toISOString();

      // Initialize tracked state for node if needed
      if (nodeId) {
        if (!nextTrackedState[runId]) {
          nextTrackedState[runId] = {};
        }
        if (!nextTrackedState[runId][nodeId]) {
          nextTrackedState[runId][nodeId] = createEmptyTrackedState();
        }
      }

      // Handle run-level events
      if (evType.startsWith('run.')) {
        const patch = ev.run as Record<string, unknown> | undefined;
        if (patch) {
          Object.assign(nextRun, patch);
        }
        // Handle mode and phase changes specifically
        if (evType === 'run.mode.changed') {
          const mode = ev.mode as RunMode;
          nextRun.mode = mode;
        }
        if (evType === 'run.phase.changed') {
          const phase = ev.phase as RunPhase;
          nextRun.phase = phase;
        }
      }
      // Handle node-level events
      else if (evType.startsWith('node.')) {
        if (nodeId) {
          nextRun.nodes = { ...nextRun.nodes };
          const node = nextRun.nodes[nodeId] || { id: nodeId, label: nodeId, status: 'queued' };
          const patch = ev.patch as Record<string, unknown> | undefined;
          if (patch) {
            Object.assign(node, patch);
          }
          nextRun.nodes[nodeId] = node;

          // Track node.progress in logs
          if (evType === 'node.progress') {
            nextNodeLogs[runId] = { ...(nextNodeLogs[runId] || {}) };
            const lines = nextNodeLogs[runId][nodeId] || [];
            const message = ev.message as string | undefined;
            const line = `${new Date(ts).toLocaleTimeString()} ${message || ''}`;
            const newLines = [...lines, line];
            if (newLines.length > 300) newLines.shift();
            nextNodeLogs[runId][nodeId] = newLines;

            // Also add to events
            const nodeState = nextTrackedState[runId][nodeId];
            nodeState.events = [
              ...nodeState.events,
              {
                id: generateId(),
                type: evType,
                runId,
                nodeId,
                timestamp: ts,
                message: message || '',
                raw: ev,
              },
            ];
          }
        }
      }
      // Handle edge events
      else if (evType === 'edge.created') {
        // Map daemon's from/to to UI's source/target
        const rawEdge = ev.edge as { id: string; from: string; to: string; type: string; label?: string };
        const edge: Edge = {
          id: rawEdge.id,
          source: rawEdge.from,
          target: rawEdge.to,
          type: rawEdge.type as Edge['type'],
          label: rawEdge.label,
        };
        nextRun.edges = { ...nextRun.edges, [edge.id]: edge };
      }
      // Handle artifact events
      else if (evType === 'artifact.created') {
        const artifact = ev.artifact as Artifact;
        nextRun.artifacts = { ...nextRun.artifacts, [artifact.id]: artifact };
      }
      // Handle verification events
      else if (evType === 'verification.completed') {
        if (nodeId && nextRun.nodes && nextRun.nodes[nodeId]) {
          nextRun.nodes = { ...nextRun.nodes };
          nextRun.nodes[nodeId] = { ...nextRun.nodes[nodeId], output: ev.report };
        }
      }
      // Handle message events
      else if (evType.startsWith('message.')) {
        if (nodeId && nextTrackedState[runId]?.[nodeId]) {
          const nodeState = nextTrackedState[runId][nodeId];
          const content = (ev.content as string) || (ev.delta as string) || '';

          if (evType === 'message.user') {
            nodeState.messages = [
              ...nodeState.messages,
              {
                id: generateId(),
                type: 'user',
                content,
                timestamp: ts,
                nodeId,
              },
            ];
          } else if (evType === 'message.assistant.delta') {
            // Find existing partial message or create new one
            const existingIdx = nodeState.messages.findIndex(
              (m: MessageEvent) => m.type === 'assistant' && m.isPartial
            );
            if (existingIdx >= 0) {
              const existing = nodeState.messages[existingIdx];
              nodeState.messages = [
                ...nodeState.messages.slice(0, existingIdx),
                { ...existing, content: existing.content + content },
                ...nodeState.messages.slice(existingIdx + 1),
              ];
            } else {
              nodeState.messages = [
                ...nodeState.messages,
                {
                  id: generateId(),
                  type: 'assistant',
                  content,
                  timestamp: ts,
                  nodeId,
                  isPartial: true,
                },
              ];
            }
          } else if (evType === 'message.assistant.final') {
            // Finalize any partial message or create new complete one
            const existingIdx = nodeState.messages.findIndex(
              (m: MessageEvent) => m.type === 'assistant' && m.isPartial
            );
            if (existingIdx >= 0) {
              nodeState.messages = [
                ...nodeState.messages.slice(0, existingIdx),
                { ...nodeState.messages[existingIdx], content, isPartial: false },
                ...nodeState.messages.slice(existingIdx + 1),
              ];
            } else {
              nodeState.messages = [
                ...nodeState.messages,
                {
                  id: generateId(),
                  type: 'assistant',
                  content,
                  timestamp: ts,
                  nodeId,
                },
              ];
            }
          } else if (evType === 'message.reasoning') {
            nodeState.messages = [
              ...nodeState.messages,
              {
                id: generateId(),
                type: 'reasoning',
                content,
                timestamp: ts,
                nodeId,
              },
            ];
          }

          // Add to events log
          nodeState.events = [
            ...nodeState.events,
            {
              id: generateId(),
              type: evType,
              runId,
              nodeId,
              timestamp: ts,
              message: content.slice(0, 100),
              raw: ev,
            },
          ];
        }
      }
      // Handle tool events
      else if (evType.startsWith('tool.')) {
        if (nodeId && nextTrackedState[runId]?.[nodeId]) {
          const nodeState = nextTrackedState[runId][nodeId];
          const toolId = ev.toolId as string;

          if (evType === 'tool.proposed') {
            const tool = ev.tool as {
              id: string;
              name: string;
              args: Record<string, unknown>;
              riskLevel: ToolRiskLevel;
            };
            nodeState.tools = [
              ...nodeState.tools,
              {
                id: generateId(),
                toolId: tool.id,
                name: tool.name,
                args: tool.args,
                riskLevel: tool.riskLevel,
                status: 'proposed',
                timestamp: ts,
                nodeId,
              },
            ];
          } else if (evType === 'tool.started') {
            const idx = nodeState.tools.findIndex((t: ToolEvent) => t.toolId === toolId);
            if (idx >= 0) {
              nodeState.tools = [
                ...nodeState.tools.slice(0, idx),
                { ...nodeState.tools[idx], status: 'started' },
                ...nodeState.tools.slice(idx + 1),
              ];
            }
          } else if (evType === 'tool.completed') {
            const idx = nodeState.tools.findIndex((t: ToolEvent) => t.toolId === toolId);
            const result = ev.result;
            const error = ev.error as { message: string } | undefined;
            const durationMs = ev.durationMs as number | undefined;
            if (idx >= 0) {
              nodeState.tools = [
                ...nodeState.tools.slice(0, idx),
                {
                  ...nodeState.tools[idx],
                  status: error ? 'failed' : 'completed',
                  result,
                  error,
                  durationMs,
                },
                ...nodeState.tools.slice(idx + 1),
              ];
            }
          }

          // Add to events log
          nodeState.events = [
            ...nodeState.events,
            {
              id: generateId(),
              type: evType,
              runId,
              nodeId,
              timestamp: ts,
              message: `Tool ${toolId}`,
              raw: ev,
            },
          ];
        }
      }
      // Handle console.chunk events
      else if (evType === 'console.chunk') {
        if (nodeId && nextTrackedState[runId]?.[nodeId]) {
          const nodeState = nextTrackedState[runId][nodeId];
          const stream = (ev.stream as 'stdout' | 'stderr') || 'stdout';
          const data = (ev.data as string) || '';

          nodeState.consoleChunks = [
            ...nodeState.consoleChunks,
            {
              id: generateId(),
              nodeId,
              stream,
              data,
              timestamp: ts,
            },
          ];
        }
      }
      // Handle approval events
      else if (evType === 'approval.requested') {
        const approval = ev.approval as ApprovalRequest;
        nextApprovals = [...nextApprovals, approval];
      } else if (evType === 'approval.resolved') {
        const approvalId = ev.approvalId as string;
        nextApprovals = nextApprovals.filter((a) => a.id !== approvalId);
      }
      // Handle chat events
      else if (evType === 'chat.message.sent' || evType === 'chat.message.queued') {
        const message = ev.message as ChatMessage;
        const nextChatMessages = { ...s.chatMessages };
        if (!nextChatMessages[runId]) {
          nextChatMessages[runId] = [];
        }
        nextChatMessages[runId] = [...nextChatMessages[runId], message];
        return {
          ...s,
          runs: { ...s.runs, [runId]: nextRun },
          nodeLogs: nextNodeLogs,
          nodeTrackedState: nextTrackedState,
          pendingApprovals: nextApprovals,
          chatMessages: nextChatMessages,
        };
      }
      // Handle interaction mode changed events
      else if (evType === 'interaction.mode.changed') {
        const mode = ev.mode as InteractionMode;
        const eventNodeId = ev.nodeId as string | undefined;
        const key = eventNodeId ? `${runId}:${eventNodeId}` : runId;
        const nextModes = { ...s.interactionModes, [key]: mode };
        return {
          ...s,
          runs: { ...s.runs, [runId]: nextRun },
          nodeLogs: nextNodeLogs,
          nodeTrackedState: nextTrackedState,
          pendingApprovals: nextApprovals,
          interactionModes: nextModes,
        };
      }
      // Handle prompt queue events
      else if (evType === 'prompt.queued') {
        const prompt = ev.prompt as PendingPrompt;
        const nextPromptQueue = { ...s.promptQueue };
        if (!nextPromptQueue[runId]) {
          nextPromptQueue[runId] = [];
        }
        // Check if prompt already exists (update) or is new (add)
        const existingIdx = nextPromptQueue[runId].findIndex((p) => p.id === prompt.id);
        if (existingIdx >= 0) {
          nextPromptQueue[runId] = [
            ...nextPromptQueue[runId].slice(0, existingIdx),
            prompt,
            ...nextPromptQueue[runId].slice(existingIdx + 1),
          ];
        } else {
          nextPromptQueue[runId] = [...nextPromptQueue[runId], prompt];
        }
        return {
          ...s,
          runs: { ...s.runs, [runId]: nextRun },
          nodeLogs: nextNodeLogs,
          nodeTrackedState: nextTrackedState,
          pendingApprovals: nextApprovals,
          promptQueue: nextPromptQueue,
        };
      }
      else if (evType === 'prompt.sent' || evType === 'prompt.cancelled') {
        const promptId = ev.promptId as string;
        const nextPromptQueue = { ...s.promptQueue };
        if (nextPromptQueue[runId]) {
          nextPromptQueue[runId] = nextPromptQueue[runId].map((p) =>
            p.id === promptId
              ? { ...p, status: evType === 'prompt.sent' ? 'sent' as const : 'cancelled' as const }
              : p
          );
        }
        return {
          ...s,
          runs: { ...s.runs, [runId]: nextRun },
          nodeLogs: nextNodeLogs,
          nodeTrackedState: nextTrackedState,
          pendingApprovals: nextApprovals,
          promptQueue: nextPromptQueue,
        };
      }

      return {
        ...s,
        runs: { ...s.runs, [runId]: nextRun },
        nodeLogs: nextNodeLogs,
        nodeTrackedState: nextTrackedState,
        pendingApprovals: nextApprovals,
      };
    });
  };

  // Sync run statuses periodically to catch any missed WebSocket events
  const syncRunStatuses = useCallback(async () => {
    try {
      const data = await httpGet('/api/runs');
      const freshRuns = data.runs || [];
      setState((s) => {
        const nextRuns = { ...s.runs };
        let changed = false;
        for (const freshRun of freshRuns) {
          const existing = nextRuns[freshRun.id];
          // Update if status differs or run doesn't exist locally
          if (!existing || existing.status !== freshRun.status) {
            const mapped = { ...existing, ...freshRun };
            // Map edges from daemon format (from/to) to UI format (source/target)
            if (freshRun.edges) {
              mapped.edges = mapEdges(freshRun.edges as Record<string, unknown>);
            }
            nextRuns[freshRun.id] = mapped;
            changed = true;
          }
        }
        // Remove runs that no longer exist on server
        for (const runId of Object.keys(nextRuns)) {
          if (!freshRuns.find((r: { id: string }) => r.id === runId)) {
            delete nextRuns[runId];
            changed = true;
          }
        }
        return changed ? { ...s, runs: nextRuns } : s;
      });
    } catch (e) {
      console.error('Failed to sync run statuses:', e);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
    fetchRuns();
    fetchPendingApprovals();
    connectWs();

    // Periodic sync every 30 seconds to catch missed events
    const syncInterval = setInterval(syncRunStatuses, 30000);

    return () => {
      if (wsRef.current) wsRef.current.close();
      clearInterval(syncInterval);
    };
  }, [fetchProviders, fetchRuns, fetchPendingApprovals, connectWs, syncRunStatuses]);

  // Helper to get tracked state for a specific node
  const getNodeTrackedState = useCallback(
    (runId: string, nodeId: string): NodeTrackedState => {
      return state.nodeTrackedState[runId]?.[nodeId] || createEmptyTrackedState();
    },
    [state.nodeTrackedState]
  );

  const updateEdge = useCallback((runId: string, edgeId: string, updates: Partial<Edge>) => {
    setState((s) => {
      const run = s.runs[runId];
      if (!run) return s;
      const edges = run.edges;
      if (!edges || !edges[edgeId]) return s;
      const nextEdge = { ...edges[edgeId], ...updates };
      const nextRun = {
        ...run,
        edges: {
          ...edges,
          [edgeId]: nextEdge,
        },
      };
      return {
        ...s,
        runs: {
          ...s.runs,
          [runId]: nextRun,
        },
      };
    });
  }, []);

  const createEdge = useCallback(async (runId: string, sourceId: string, targetId: string, type: string = 'handoff', label?: string) => {
    await httpPost(`/api/runs/${runId}/edges`, { sourceId, targetId, type, label });
  }, []);

  const createNode = useCallback(async (
    runId: string,
    providerId: string,
    params: {
      parentNodeId?: string;
      role?: string;
      label?: string;
      control?: 'AUTO' | 'MANUAL';
    }
  ) => {
    return await httpPost(`/api/runs/${runId}/nodes`, { providerId, ...params });
  }, []);

  return {
    ...state,
    isLoadingRuns,
    isLoadingProviders,
    createRun,
    stopRun,
    deleteRun,
    archiveRun,
    unarchiveRun,
    renameRun,
    pauseRun,
    resumeRun,
    getConfig,
    saveConfig,
    refreshRuns: fetchRuns,
    refreshApprovals: fetchPendingApprovals,
    syncRunStatuses,
    approveRequest,
    denyRequest,
    modifyRequest,
    getNodeTrackedState,
    updateEdge,
    createEdge,
    createNode,
    // Chat methods
    sendChatMessage,
    queueChatMessage,
    setInteractionMode,
    getInteractionMode,
    getChatMessages,
    // Run mode methods (AUTO/INTERACTIVE orchestration control)
    setRunMode,
    getRunMode,
    getRunPhase,
    // Prompt queue methods (Section 3.4)
    fetchPrompts,
    getPrompts,
    getPendingPrompts,
    sendPrompt,
    cancelPrompt,
    modifyPrompt,
    addUserPrompt,
  };
}
