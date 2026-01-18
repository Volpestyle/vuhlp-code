import { useEffect, useState, useRef, useCallback } from 'react';
import type { EventEnvelope, NodeState } from '@vuhlp/contracts';
import { api, getWebSocketUrl } from './api';
import { useGraphStore, type ChatMessage, type PendingApproval } from '@/stores/graph-store';

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

  const setRun = useGraphStore((s) => s.setRun);
  const applyRunPatch = useGraphStore((s) => s.applyRunPatch);
  const addNode = useGraphStore((s) => s.addNode);
  const updateNode = useGraphStore((s) => s.updateNode);
  const removeNode = useGraphStore((s) => s.removeNode);
  const addEdge = useGraphStore((s) => s.addEdge);
  const removeEdge = useGraphStore((s) => s.removeEdge);
  const addChatMessage = useGraphStore((s) => s.addChatMessage);
  const appendStreamingContent = useGraphStore((s) => s.appendStreamingContent);
  const finalizeStreaming = useGraphStore((s) => s.finalizeStreaming);
  const addApproval = useGraphStore((s) => s.addApproval);
  const removeApproval = useGraphStore((s) => s.removeApproval);
  const reset = useGraphStore((s) => s.reset);

  const handleEvent = useCallback(
    (event: EventEnvelope) => {
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
          break;

        case 'node.deleted':
          removeNode(event.nodeId);
          break;

        case 'node.progress':
          updateNode(event.nodeId, {
            status: event.status,
            summary: event.summary,
          });
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
            role: 'user',
            content: event.message.content,
            timestamp: event.message.createdAt,
          };
          addChatMessage(userMsg);
          break;
        }

        case 'message.assistant.delta':
          appendStreamingContent(event.nodeId, event.delta);
          break;

        case 'message.assistant.final':
          finalizeStreaming(event.nodeId, event.content);
          break;

        case 'approval.requested': {
          const approval: PendingApproval = {
            id: event.approvalId,
            nodeId: event.nodeId,
            toolName: event.tool.name,
            toolArgs: event.tool.args as Record<string, unknown>,
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
        case 'handoff.sent':
        case 'tool.proposed':
        case 'tool.started':
        case 'tool.completed':
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
      appendStreamingContent,
      finalizeStreaming,
      addApproval,
      removeApproval,
    ]
  );

  const connect = useCallback(() => {
    if (!runId) return;

    const ws = new WebSocket(getWebSocketUrl(runId));
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[ws] connected');
      reconnectAttemptsRef.current = 0;
      setState((s) => ({ ...s, connected: true }));
    };

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as EventEnvelope;
        handleEvent(event);
      } catch (err) {
        console.error('[ws] failed to parse event:', err);
      }
    };

    ws.onerror = (e) => {
      console.error('[ws] error:', e);
    };

    ws.onclose = () => {
      console.log('[ws] disconnected');
      setState((s) => ({ ...s, connected: false }));

      // Exponential backoff reconnect
      const attempts = reconnectAttemptsRef.current;
      if (attempts < 5) {
        const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
        console.log(`[ws] reconnecting in ${delay}ms...`);
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectAttemptsRef.current++;
          connect();
        }, delay);
      }
    };
  }, [runId, handleEvent]);

  // Initial fetch + WebSocket connection
  useEffect(() => {
    if (!runId) {
      setState({ loading: false, error: 'No run ID', connected: false });
      return;
    }

    reset();
    setState({ loading: true, error: null, connected: false });

    api
      .getRun(runId)
      .then((run) => {
        setRun(run);
        setState((s) => ({ ...s, loading: false }));
        connect();
      })
      .catch((err: Error) => {
        setState({ loading: false, error: err.message, connected: false });
      });

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [runId, setRun, reset, connect]);

  return state;
}
