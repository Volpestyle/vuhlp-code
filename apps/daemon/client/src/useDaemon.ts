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

// Global mode types (PLANNING vs IMPLEMENTATION)
export type GlobalMode = 'PLANNING' | 'IMPLEMENTATION';

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
  role: 'user' | 'system' | 'assistant';
  content: string;
  timestamp: string;
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

// Extracted reducer for batch processing (e.g. historical events)
function reduceDaemonState(s: ExtendedDaemonState, ev: Record<string, unknown>): ExtendedDaemonState {
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
  const isNodeDeleted = evType === 'node.deleted';

  // Initialize tracked state for node if needed (with proper immutability)
  if (nodeId && !isNodeDeleted) {
    if (!nextTrackedState[runId]) {
      nextTrackedState[runId] = {};
    } else {
      // Create new reference for run-level object
      nextTrackedState[runId] = { ...nextTrackedState[runId] };
    }
    if (!nextTrackedState[runId][nodeId]) {
      nextTrackedState[runId][nodeId] = createEmptyTrackedState();
    } else {
      // Create new reference for node-level object so React detects changes
      nextTrackedState[runId][nodeId] = { ...nextTrackedState[runId][nodeId] };
    }
  }

  // Handle run-level events
  if (evType.startsWith('run.')) {
    const patch = ev.run as Record<string, unknown> | undefined; // Legacy generic patch
    const patchData = ev.patch as Record<string, unknown> | undefined; // Standard patch
    const data = patch || patchData;

    if (data) {
      Object.assign(nextRun, data);
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
  else if (evType === 'node.deleted') {
    if (nodeId) {
      nextRun.nodes = { ...nextRun.nodes };
      delete nextRun.nodes[nodeId];

      if (nextRun.edges) {
        const nextEdges = { ...nextRun.edges };
        for (const [edgeId, edge] of Object.entries(nextEdges)) {
          if (edge.source === nodeId || edge.target === nodeId) {
            delete nextEdges[edgeId];
          }
        }
        nextRun.edges = nextEdges;
      }

      if (nextRun.artifacts) {
        const nextArtifacts = { ...nextRun.artifacts };
        for (const [artifactId, artifact] of Object.entries(nextArtifacts)) {
          if (artifact.nodeId === nodeId) {
            delete nextArtifacts[artifactId];
          }
        }
        nextRun.artifacts = nextArtifacts;
      }

      if (nextNodeLogs[runId]) {
        const runLogs = { ...nextNodeLogs[runId] };
        delete runLogs[nodeId];
        nextNodeLogs[runId] = runLogs;
      }

      if (nextTrackedState[runId]) {
        const runTracked = { ...nextTrackedState[runId] };
        delete runTracked[nodeId];
        nextTrackedState[runId] = runTracked;
      }

      nextApprovals = nextApprovals.filter((approval) => approval.nodeId !== nodeId);
    }
  } else if (evType.startsWith('node.')) {
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
        // Deduplication: Check if we've already seen this event ID in the logs
        // Logic: Check the last 10 events for this node to see if the ID matches
        const nodeState = nextTrackedState[runId][nodeId];
        const lastEvents = nodeState.events.slice(-20);
        const isDuplicate = lastEvents.some((e) => (e.raw as any)?.id === ev.id);

        if (!isDuplicate) {
          nextNodeLogs[runId] = { ...(nextNodeLogs[runId] || {}) };
          const lines = nextNodeLogs[runId][nodeId] || [];
          const message = ev.message as string | undefined;
          const line = `${new Date(ts).toLocaleTimeString()} ${message || ''}`;
          const newLines = [...lines, line];
          if (newLines.length > 300) newLines.shift();
          nextNodeLogs[runId][nodeId] = newLines;

          // Also add to events
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
      const eventId = (ev.id as string) || generateId();

      // Check if we already have this event (deduplication)
      const existingEventIds = new Set(nodeState.messages.map((m: MessageEvent) => m.id));
      if (existingEventIds.has(eventId) && evType !== 'message.assistant.delta') {
        // Skip duplicate event (except deltas which append content)
      } else if (evType === 'message.user') {
        nodeState.messages = [
          ...nodeState.messages,
          {
            id: eventId,
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
              id: eventId,
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
              id: eventId,
              type: 'assistant',
              content,
              timestamp: ts,
              nodeId,
            },
          ];
        }

        // Also add to chatMessages for the Inspector Conversation tab
        const nextChatMessages = { ...s.chatMessages };
        if (!nextChatMessages[runId]) {
          nextChatMessages[runId] = [];
        }
        // Deduplicate by event ID
        const existingChatIds = new Set(nextChatMessages[runId].map(m => m.id));
        if (!existingChatIds.has(eventId)) {
          nextChatMessages[runId] = [
            ...nextChatMessages[runId],
            {
              id: eventId,
              runId,
              nodeId,
              role: 'assistant' as const,
              content,
              timestamp: ts,
              processed: true,
              interruptedExecution: false,
            },
          ];
        }

        // Return early with chatMessages included
        return {
          ...s,
          runs: { ...s.runs, [runId]: nextRun },
          nodeLogs: nextNodeLogs,
          nodeTrackedState: nextTrackedState,
          pendingApprovals: nextApprovals,
          chatMessages: nextChatMessages,
        };
      } else if (evType === 'message.reasoning') {
        nodeState.messages = [
          ...nodeState.messages,
          {
            id: eventId,
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
    if (approval) {
      nextApprovals = [...nextApprovals, approval];
    }
  } else if (evType === 'approval.resolved') {
    const approvalId = ev.approvalId as string;
    nextApprovals = nextApprovals.filter((a) => a.id !== approvalId);
  }
  // Handle chat events
  else if (evType === 'chat.message.sent' || evType === 'chat.message.queued') {
    const rawMessage = ev.message as any;
    const message: ChatMessage = {
      ...rawMessage,
      timestamp: rawMessage.createdAt || rawMessage.timestamp || new Date().toISOString()
    };
    const nextChatMessages = { ...s.chatMessages };
    if (!nextChatMessages[runId]) {
      nextChatMessages[runId] = [];
    }
    // Deduplicate by message ID to prevent duplicates when fetchEvents replays historical events
    const existingIds = new Set(nextChatMessages[runId].map(m => m.id));
    if (!existingIds.has(message.id)) {
      nextChatMessages[runId] = [...nextChatMessages[runId], message];
    }
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
        const nextChatMessages = { ...s.chatMessages };
        for (const r of data.runs || []) {
          const mapped = { ...nextRuns[r.id], ...r };
          // Map edges from daemon format (from/to) to UI format (source/target)
          if (r.edges) {
            mapped.edges = mapEdges(r.edges as Record<string, unknown>);
          }
          nextRuns[r.id] = mapped;

          // Hydrate chat messages
          if (r.chatMessages && Array.isArray(r.chatMessages)) {
            nextChatMessages[r.id] = r.chatMessages.map((m: any) => ({
              ...m,
              timestamp: m.createdAt || m.timestamp || new Date().toISOString()
            })) as ChatMessage[];
          }
        }
        return { ...s, runs: nextRuns, chatMessages: nextChatMessages };
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
      setState((s) => ({ ...s, pendingApprovals: (data.approvals || []).filter(Boolean) }));
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

  // Subscribe to WebSocket events for a run
  const subscribeToRun = useCallback((runId: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', runId }));
    }
  }, []);

  const createRun = useCallback(async (prompt: string, repoPath: string) => {
    const data = await httpPost('/api/runs', { prompt, repoPath });
    // Subscribe to WebSocket events for the new run
    subscribeToRun(data.runId);
    // Fetch runs immediately to ensure we have the new run in the list
    await fetchRuns();
    return data.runId as string;
  }, [fetchRuns, subscribeToRun]);

  const updateNode = useCallback(
    async (runId: string, nodeId: string, updates: Record<string, any>) => {
      try {
        const result = await httpPatch(`/api/runs/${runId}/nodes/${nodeId}`, updates);
        return result.node;
      } catch (e) {
        console.error('Failed to update node:', e);
        throw e;
      }
    },
    []
  );

  const stopRun = useCallback(async (runId: string) => {
    await httpPost(`/api/runs/${runId}/stop`, {});
  }, []);

  const stopNode = useCallback(async (runId: string, nodeId: string) => {
    await httpPost(`/api/runs/${runId}/nodes/${nodeId}/stop`, {});
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
      const nodeId = options?.nodeId;

      // Ensure we're subscribed to receive the response
      subscribeToRun(runId);

      // No optimistic update - server emits message.user event which will show the message
      await httpPost(`/api/runs/${runId}/chat`, {
        content,
        nodeId,
        interrupt: options?.interrupt ?? true,
      });
    },
    [subscribeToRun]
  );

  const queueChatMessage = useCallback(
    async (runId: string, content: string, nodeId?: string) => {
      // Ensure we're subscribed to receive updates
      subscribeToRun(runId);

      await httpPost(`/api/runs/${runId}/chat`, {
        content,
        nodeId,
        interrupt: false,
      });
    },
    [subscribeToRun]
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
      return (run?.phase as RunPhase) || null;
    },
    [state.runs]
  );

  const getGlobalMode = useCallback(
    (runId: string): GlobalMode => {
      const run = state.runs[runId];
      // Default to PLANNING if not set (legacy runs)
      return (run?.globalMode as GlobalMode) ?? 'PLANNING';
    },
    [state.runs]
  );

  const setGlobalMode = useCallback(
    async (runId: string, mode: GlobalMode) => {
      // Optimistic update
      setState((s) => {
        const run = s.runs[runId];
        if (!run) return s;
        return {
          ...s,
          runs: {
            ...s.runs,
            [runId]: { ...run, globalMode: mode }
          }
        }
      });
      await httpPost(`/api/runs/${runId}/global_mode`, { mode });
    },
    []
  );

  const getSkipCliPermissions = useCallback(
    (runId: string): boolean => {
      const run = state.runs[runId];
      // Default to true (skip permissions) for backward compatibility
      return run?.policy?.skipCliPermissions ?? true;
    },
    [state.runs]
  );

  const setSkipCliPermissions = useCallback(
    async (runId: string, skip: boolean) => {
      // Optimistic update
      setState((s) => {
        const run = s.runs[runId];
        if (!run) return s;
        return {
          ...s,
          runs: {
            ...s.runs,
            [runId]: {
              ...run,
              policy: {
                ...run.policy,
                skipCliPermissions: skip
              }
            }
          }
        }
      });
      await httpPost(`/api/runs/${runId}/policy/skip_cli_permissions`, { skip });
    },
    []
  );

  // Check if we have events for a run, if not fetch them
  const fetchEvents = useCallback(async (runId: string) => {
    // Subscribe to live events for this run
    subscribeToRun(runId);

    // Fetch historical events
    try {
      const events = await httpGet(`/api/runs/${runId}/events`);
      if (events.events && Array.isArray(events.events)) {
        if (events.events.length > 500) {
          console.warn("Large event history, truncating for performance?");
        }
        // Process all events in a single setState to avoid intermediate renders
        // Clear nodeTrackedState so it rebuilds from events (messages, tools, etc.)
        // Keep chatMessages - they're already deduplicated in the reducer
        setState(s => {
          let current = {
            ...s,
            nodeTrackedState: { ...s.nodeTrackedState, [runId]: {} },
          };
          events.events.forEach((ev: any) => {
            current = reduceDaemonState(current, ev);
          });
          return current;
        });
      }
    } catch (e) {
      console.error("Failed to fetch events", e);
    }
  }, [subscribeToRun]);

  const getChatMessages = useCallback(
    (runId: string, nodeId?: string): ChatMessage[] => {
      const messages = state.chatMessages[runId] || [];
      if (nodeId) {
        return messages.filter((m) => m.nodeId === nodeId);
      }
      return messages;
    },
    [state.chatMessages]
  );

  // Prompt Queue Methods (Section 3.4)
  const getPrompts = useCallback(
    (runId: string): PendingPrompt[] => {
      return state.promptQueue[runId] || [];
    },
    [state.promptQueue]
  );

  const sendPrompt = useCallback(
    async (runId: string, promptId: string) => {
      await httpPost(`/api/runs/${runId}/prompts/${promptId}/send`, {});
    },
    []
  );

  const cancelPrompt = useCallback(
    async (runId: string, promptId: string) => {
      await httpPost(`/api/runs/${runId}/prompts/${promptId}/cancel`, {});
    },
    []
  );

  const modifyPrompt = useCallback(
    async (runId: string, promptId: string, newContent: string) => {
      await httpPatch(`/api/runs/${runId}/prompts/${promptId}`, { content: newContent });
    },
    []
  );

  const addUserPrompt = useCallback(
    async (runId: string, content: string, targetNodeId?: string) => {
      await httpPost(`/api/runs/${runId}/prompts`, { content, targetNodeId });
    },
    []
  );

  const getNodeTrackedState = useCallback(
    (runId: string, nodeId: string): NodeTrackedState => {
      return state.nodeTrackedState[runId]?.[nodeId] || createEmptyTrackedState();
    },
    [state.nodeTrackedState]
  );

  // Effect to manage WS connection
  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        // Use relative path for dev (vite proxy handles it) or direct port in prod
        // In this harness we assume same origin proxy or direct
        const host = window.location.host;
        ws = new WebSocket(`${protocol}//${host}/ws`);
        wsRef.current = ws;

        ws.onopen = () => {
          setState((s) => ({ ...s, connStatus: 'connected' }));
          // Re-subscribe to active runs if any (e.g. if we had them in URL state)
          // For now main UI manages active run subscription via effect
        };

        ws.onclose = () => {
          setState((s) => ({ ...s, connStatus: 'disconnected' }));
          reconnectTimer = setTimeout(connect, 2000);
        };

        ws.onerror = (err) => {
          console.error('WS error', err);
          ws.close();
        };

        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);
            setState((s) => reduceDaemonState(s, data));
          } catch (e) {
            console.error('Failed to parse WS message', e);
          }
        };
      } catch (e) {
        console.error('Failed to create WebSocket', e);
        reconnectTimer = setTimeout(connect, 2000);
      }
    };

    connect();

    // Initial fetch
    void fetchRuns(true);
    void fetchProviders();
    void fetchPendingApprovals();

    return () => {
      if (ws) ws.close();
      clearTimeout(reconnectTimer);
    };
  }, [fetchRuns, fetchProviders, fetchPendingApprovals]);

  // Poll for approvals and prompts every 2s as backup/supplement to WS
  useEffect(() => {
    const timer = setInterval(() => {
      void fetchPendingApprovals();

      // Refresh runs occasionally to sync state if missed events
      // void fetchRuns(); // Disable for now to avoid flickering/overhead

    }, 2000);
    return () => clearInterval(timer);
  }, [fetchPendingApprovals]);

  return {
    ...state,
    isLoadingRuns,
    isLoadingProviders,
    fetchRuns,
    fetchProviders,
    refreshRuns: (includeArchived?: boolean) => fetchRuns(includeArchived),
    getConfig,
    saveConfig,
    createRun,
    updateNode,
    stopRun,
    stopNode,
    deleteRun,
    archiveRun,
    unarchiveRun,
    renameRun,
    pauseRun,
    resumeRun,
    // Approvals
    approveRequest,
    denyRequest,
    modifyRequest,
    // Chat
    sendChatMessage,
    queueChatMessage,
    getChatMessages,
    setInteractionMode,
    getInteractionMode,
    // Run mode
    setRunMode,
    getRunMode,
    getRunPhase,
    setGlobalMode,
    getGlobalMode,
    // CLI Permissions
    getSkipCliPermissions,
    setSkipCliPermissions,
    // Prompt Queue
    getPrompts,
    sendPrompt,
    cancelPrompt,
    modifyPrompt,
    addUserPrompt,
    // Node State
    getNodeTrackedState,
    fetchEvents,
    subscribeToRun,
    // Graph Editor (local state helper)
    updateEdge: (runId: string, edgeId: string, updates: Partial<Edge>) => {
      setState((s) => {
        const run = s.runs[runId];
        if (!run?.edges?.[edgeId]) return s;
        // Map UI edge back to daemon edge if needed, but here we just update UI state locally
        const nextEdges = { ...run.edges, [edgeId]: { ...run.edges[edgeId], ...updates } };
        return { ...s, runs: { ...s.runs, [runId]: { ...run, edges: nextEdges } } };
      });
    },
    createEdge: (runId: string, sourceId: string, targetId: string) => {
      // Placeholder: Implementation currently relies on backend creating edges via graph commands or explicitly
      // We can add an API for manual edge creation if needed
      console.log("Create edge not implemented via API yet", runId, sourceId, targetId);
    },
    deleteEdge: (runId: string, edgeId: string) => {
      // Placeholder
      console.log("Delete edge not implemented via API yet", runId, edgeId);
    },
    createNode: async (runId: string, providerId: string, params: { label: string; control?: any; role?: string }) => {
      await httpPost(`/api/runs/${runId}/nodes`, {
        providerId,
        label: params.label,
        control: params.control,
        role: params.role
      });
      // Refresh runs to see the new node
      await fetchRuns();
    },
    deleteNode: async (runId: string, nodeId: string) => {
      await httpDelete(`/api/runs/${runId}/nodes/${nodeId}`);
      await fetchRuns();
    },
  };
}
