import { useEffect, useState, useRef, useCallback } from 'react';
import type { EventEnvelope, NodeState, ChatMessage, ToolEvent } from '@vuhlp/contracts';
import { api, getWebSocketUrl } from './api';
import {
  useGraphStore,
  type PendingApproval,
  type TurnStatusEvent,
} from '@/stores/graph-store';

interface ConnectionState {
  loading: boolean;
  error: string | null;
  connected: boolean;
}

const hasNodeCoreFields = (patch: Partial<NodeState>): patch is Partial<NodeState> & {
  label: string;
  roleTemplate: string;
  provider: string;
  status: string;
  summary: string;
  lastActivityAt: string;
  capabilities: NodeState['capabilities'];
  permissions: NodeState['permissions'];
  session: NodeState['session'];
} =>
  Boolean(
    patch &&
    typeof patch.label === 'string' &&
    typeof patch.roleTemplate === 'string' &&
    typeof patch.provider === 'string' &&
    typeof patch.status === 'string' &&
    typeof patch.summary === 'string' &&
    typeof patch.lastActivityAt === 'string' &&
    patch.capabilities &&
    patch.permissions &&
    patch.session
  );

export function useRunConnection(runId: string | undefined): ConnectionState {
  const [state, setState] = useState<ConnectionState>({
    loading: true,
    error: null,
    connected: false,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const connectionIdRef = useRef(0);
  const seenEventIdsRef = useRef<Set<string>>(new Set());

  const setRun = useGraphStore((s) => s.setRun);
  const applyRunPatch = useGraphStore((s) => s.applyRunPatch);
  const addNode = useGraphStore((s) => s.addNode);
  const updateNode = useGraphStore((s) => s.updateNode);
  const removeNode = useGraphStore((s) => s.removeNode);
  const addEdge = useGraphStore((s) => s.addEdge);
  const removeEdge = useGraphStore((s) => s.removeEdge);
  const addChatMessage = useGraphStore((s) => s.addChatMessage);
  const appendAssistantDelta = useGraphStore((s) => s.appendAssistantDelta);
  const finalizeAssistantMessage = useGraphStore((s) => s.finalizeAssistantMessage);
  const appendAssistantThinkingDelta = useGraphStore((s) => s.appendAssistantThinkingDelta);
  const finalizeAssistantThinking = useGraphStore((s) => s.finalizeAssistantThinking);
  const finalizeNodeMessages = useGraphStore((s) => s.finalizeNodeMessages);
  const addToolEvent = useGraphStore((s) => s.addToolEvent);
  const updateToolEvent = useGraphStore((s) => s.updateToolEvent);
  const addTurnStatusEvent = useGraphStore((s) => s.addTurnStatusEvent);
  const addApproval = useGraphStore((s) => s.addApproval);
  const removeApproval = useGraphStore((s) => s.removeApproval);
  const addHandoff = useGraphStore((s) => s.addHandoff);
  const reset = useGraphStore((s) => s.reset);

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const resetConnection = useCallback(
    (reason: string) => {
      connectionIdRef.current += 1;
      clearReconnectTimeout();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      console.log(`[ws] reset (${reason}) id=${connectionIdRef.current}`);
    },
    [clearReconnectTimeout]
  );

  const handleEvent = useCallback(
    (event: EventEnvelope) => {
      if (seenEventIdsRef.current.has(event.id)) {
        return;
      }
      seenEventIdsRef.current.add(event.id);
      switch (event.type) {
        case 'run.patch':
          applyRunPatch(event.patch);
          break;

        case 'node.patch':
          if (!useGraphStore.getState().run?.nodes[event.nodeId] && hasNodeCoreFields(event.patch)) {
            addNode({ ...event.patch, id: event.nodeId, runId: event.runId } as NodeState);
          } else {
            updateNode(event.nodeId, event.patch);
          }
          if (event.patch.status && event.patch.status !== 'running') {
            finalizeNodeMessages(event.nodeId, event.ts);
          }
          break;

        case 'node.deleted':
          removeNode(event.nodeId);
          break;

        case 'node.progress':
          updateNode(event.nodeId, {
            status: event.status,
            summary: event.summary,
          });
          if (event.status !== 'running') {
            finalizeNodeMessages(event.nodeId, event.ts);
          }
          break;

        case 'edge.created':
          addEdge(event.edge);
          break;

        case 'edge.deleted':
          removeEdge(event.edgeId);
          break;

        case 'message.user': {
          // Skip messages without a nodeId (broadcast messages)
          if (!event.message.nodeId) break;
          const userMsg: ChatMessage = {
            id: event.message.id,
            nodeId: event.message.nodeId,
            role: event.message.role,
            content: event.message.content,
            createdAt: event.message.createdAt,
            interrupt: event.message.interrupt,
          };
          addChatMessage(userMsg);
          break;
        }

        case 'message.assistant.delta':
          appendAssistantDelta(event.nodeId, event.delta, event.ts);
          break;

        case 'message.assistant.final':
          finalizeAssistantMessage(
            event.nodeId,
            event.content,
            event.ts,
            event.status,
            event.id
          );
          break;

        case 'message.assistant.thinking.delta':
          appendAssistantThinkingDelta(event.nodeId, event.delta, event.ts);
          break;

        case 'message.assistant.thinking.final':
          finalizeAssistantThinking(event.nodeId, event.content, event.ts);
          break;

        case 'turn.status': {
          const statusEvent: TurnStatusEvent = {
            id: event.id,
            nodeId: event.nodeId,
            status: event.status,
            detail: event.detail,
            timestamp: event.ts,
          };
          addTurnStatusEvent(statusEvent);
          break;
        }

        case 'tool.proposed': {
          const existing = useGraphStore
            .getState()
            .toolEvents.find((entry) => entry.tool.id === event.tool.id);
          if (existing) {
            break;
          }
          const toolEvent: ToolEvent = {
            id: event.id,
            nodeId: event.nodeId,
            tool: event.tool,
            status: 'proposed',
            timestamp: event.ts,
          };
          addToolEvent(toolEvent);
          break;
        }

        case 'tool.started': {
          const existing = useGraphStore
            .getState()
            .toolEvents.find((entry) => entry.tool.id === event.tool.id);
          if (existing) {
            updateToolEvent(event.tool.id, {
              status: 'started',
              tool: event.tool,
              timestamp: event.ts,
            });
            break;
          }
          const toolEvent: ToolEvent = {
            id: event.id,
            nodeId: event.nodeId,
            tool: event.tool,
            status: 'started',
            timestamp: event.ts,
          };
          addToolEvent(toolEvent);
          break;
        }

        case 'tool.completed':
          updateToolEvent(event.toolId, {
            status: event.result.ok ? 'completed' : 'failed',
            result: event.result,
            error: event.error,
            timestamp: event.ts,
          });
          break;

        case 'approval.requested': {
          const approval: PendingApproval = {
            id: event.approvalId,
            nodeId: event.nodeId,
            toolName: event.tool.name,
            toolArgs: event.tool.args,
            context: event.context,
            timestamp: event.ts,
          };
          addApproval(approval);
          break;
        }

        case 'approval.resolved':
          removeApproval(event.approvalId);
          break;

        // Events we acknowledge but don't need to handle yet
        case 'run.mode':
        case 'run.stalled':
          // Log for debugging
          console.log(`[ws] event: ${event.type}`);
          break;

        case 'handoff.sent':
          addHandoff(event.envelope);
          break;

        case 'artifact.created':
          // Log for debugging
          console.log(`[ws] event: ${event.type}`);
          break;

        default:
          // Silently ignore unknown events
          break;
      }
    },
    [
      applyRunPatch,
      addNode,
      updateNode,
      removeNode,
      addEdge,
      removeEdge,
      addChatMessage,
      appendAssistantDelta,
      finalizeAssistantMessage,
      appendAssistantThinkingDelta,
      finalizeAssistantThinking,
      finalizeNodeMessages,
      addToolEvent,
      updateToolEvent,
      addTurnStatusEvent,
      addApproval,
      removeApproval,
      addHandoff,
    ]
  );

  const syncEventsAfterConnect = useCallback(
    (connectionId: number) => {
      if (!runId) {
        return;
      }
      api
        .getRunEvents(runId)
        .then((events) => {
          if (connectionId !== connectionIdRef.current) {
            return;
          }
          for (const event of events) {
            handleEvent(event);
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[ws] failed to sync events after connect:', message);
        });
    },
    [runId, handleEvent]
  );

  const connect = useCallback(() => {
    if (!runId) return;

    resetConnection('connect');
    const connectionId = connectionIdRef.current;
    const ws = new WebSocket(getWebSocketUrl(runId));
    wsRef.current = ws;
    console.log(`[ws] connecting id=${connectionId}`);

    ws.onopen = () => {
      if (connectionId !== connectionIdRef.current) {
        ws.close();
        return;
      }
      console.log(`[ws] connected id=${connectionId}`);
      reconnectAttemptsRef.current = 0;
      setState((s) => ({ ...s, connected: true }));
      syncEventsAfterConnect(connectionId);
    };

    ws.onmessage = (e) => {
      if (connectionId !== connectionIdRef.current) {
        return;
      }
      try {
        const event = JSON.parse(e.data as string) as EventEnvelope;
        handleEvent(event);
      } catch (err) {
        console.error('[ws] failed to parse event:', err);
      }
    };

    ws.onerror = (e) => {
      if (connectionId !== connectionIdRef.current) {
        return;
      }
      console.error('[ws] error:', e);
    };

    ws.onclose = () => {
      if (connectionId !== connectionIdRef.current) {
        return;
      }
      console.log(`[ws] disconnected id=${connectionId}`);
      setState((s) => ({ ...s, connected: false }));

      // Exponential backoff reconnect
      const attempts = reconnectAttemptsRef.current;
      if (attempts < 5) {
        const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
        console.log(`[ws] reconnecting in ${delay}ms (attempt ${attempts + 1})`);
        clearReconnectTimeout();
        reconnectTimeoutRef.current = setTimeout(() => {
          if (connectionIdRef.current !== connectionId) {
            return;
          }
          reconnectAttemptsRef.current += 1;
          connect();
        }, delay);
      }
    };
  }, [runId, handleEvent, clearReconnectTimeout, resetConnection]);

  // Initial fetch + WebSocket connection
  useEffect(() => {
    if (!runId) {
      setState({ loading: false, error: 'No run ID', connected: false });
      return;
    }

    reset();
    seenEventIdsRef.current = new Set();
    setState({ loading: true, error: null, connected: false });

    Promise.all([api.getRun(runId), api.getRunEvents(runId)])
      .then(([run, events]) => {
        setRun(run);

        // Replay history (messages, tools, etc)
        // We skip patches because getRun() already returns the latest state
        for (const event of events) {
          switch (event.type) {
            case 'message.user':
            case 'message.assistant.delta':
            case 'message.assistant.final':
            case 'message.assistant.thinking.delta':
            case 'message.assistant.thinking.final':
            case 'tool.proposed':
            case 'tool.started':
            case 'tool.completed':
            case 'turn.status':
            case 'approval.requested':
            case 'approval.resolved':
              handleEvent(event);
              break;
          }
        }

        setState((s) => ({ ...s, loading: false }));
        connect();
      })
      .catch((err: Error) => {
        setState({ loading: false, error: err.message, connected: false });
      });

    return () => {
      resetConnection('cleanup');
    };
  }, [runId, setRun, reset, connect, resetConnection]);

  return state;
}
