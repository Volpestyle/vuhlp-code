import type { EventEnvelope, UsageTotals, NodeState } from '@vuhlp/contracts';
import { formatTurnSummary } from '@vuhlp/shared';
import { useRunStore, type ToolEvent, type TurnStatusEvent, type NodeLogEntry } from '../stores/runStore';

export type EventHandlingMode = 'live' | 'replay';

interface ApplyEventOptions {
  mode?: EventHandlingMode;
  allowDuplicateHandoffAnimation?: boolean;
}

const SEEN_EVENT_LIMIT = 2000;
const seenEventIds = new Set<string>();
const seenEventOrder: string[] = [];

const markEventSeen = (event: EventEnvelope): boolean => {
  const key = `${event.runId}:${event.id}`;
  if (seenEventIds.has(key)) {
    return true;
  }
  seenEventIds.add(key);
  seenEventOrder.push(key);
  if (seenEventOrder.length > SEEN_EVENT_LIMIT) {
    const oldest = seenEventOrder.shift();
    if (oldest) {
      seenEventIds.delete(oldest);
    }
  }
  return false;
};

const addUsage = (current: UsageTotals | undefined, delta: UsageTotals): UsageTotals => ({
  promptTokens: (current?.promptTokens ?? 0) + delta.promptTokens,
  completionTokens: (current?.completionTokens ?? 0) + delta.completionTokens,
  totalTokens: (current?.totalTokens ?? 0) + delta.totalTokens,
});

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

export function applyEventToStore(event: EventEnvelope, options?: ApplyEventOptions): boolean {
  const alreadySeen = markEventSeen(event);
  const allowDuplicateHandoffAnimation =
    options?.allowDuplicateHandoffAnimation === true && event.type === 'handoff.sent';
  if (alreadySeen && !allowDuplicateHandoffAnimation) {
    return true;
  }
  const mode = options?.mode ?? 'live';
  const isLive = mode === 'live';
  const store = useRunStore.getState();

  switch (event.type) {
    case 'run.patch':
      if (isLive) {
        store.applyRunPatch(event.patch);
      }
      return true;

    case 'run.mode':
      if (isLive) {
        if (event.mode) {
          store.setOrchestrationMode(event.mode);
        }
        if (event.globalMode) {
          store.setGlobalMode(event.globalMode);
        }
      }
      return true;

    case 'run.stalled':
      if (isLive) {
        console.warn('[ws] run stalled:', event);
        store.updateRunStatus('paused');
        store.setStall(event.evidence);
      }
      return true;

    case 'node.patch':
      if (isLive) {
        const existing = store.getNode(event.nodeId);
        if (!existing && hasNodeCoreFields(event.patch)) {
          store.addNode({ ...event.patch, id: event.nodeId, runId: event.runId } as NodeState);
        } else {
          store.updateNode(event.nodeId, event.patch);
        }
        if (event.patch.status && event.patch.status !== 'running') {
          store.finalizeNodeMessages(event.nodeId, event.ts);
        }
      }
      return true;

    case 'node.heartbeat': {
      if (isLive) {
        const node = store.getNode(event.nodeId);
        const connection = node?.connection;
        store.updateNode(event.nodeId, {
          connection: connection
            ? { ...connection, lastHeartbeatAt: event.ts }
            : {
              status: node?.status === 'running' ? 'connected' : 'idle',
              streaming: node?.status === 'running',
              lastHeartbeatAt: event.ts,
              lastOutputAt: event.ts,
            },
        });
      }
      return true;
    }

    case 'node.log': {
      const entry: NodeLogEntry = {
        id: event.id,
        nodeId: event.nodeId,
        source: event.source,
        line: event.line,
        timestamp: event.ts,
      };
      store.addNodeLog(entry);
      return true;
    }

    case 'node.deleted':
      if (isLive) {
        store.removeNode(event.nodeId);
      }
      return true;

    case 'node.progress':
      if (isLive) {
        store.updateNode(event.nodeId, {
          status: event.status,
          summary: event.summary,
          lastActivityAt: event.ts,
        });
        if (event.status !== 'running') {
          store.finalizeNodeMessages(event.nodeId, event.ts);
        }
      }
      return true;

    case 'turn.status': {
      const summary = formatTurnSummary(event.status, event.detail);
      const statusEvent: TurnStatusEvent = {
        id: event.id,
        nodeId: event.nodeId,
        status: event.status,
        detail: event.detail,
        timestamp: event.ts,
      };
      store.addTurnStatusEvent(statusEvent);
      if (isLive) {
        store.updateNode(event.nodeId, {
          summary,
          lastActivityAt: event.ts,
        });
      }
      return true;
    }

    case 'edge.created':
      if (!store.run) {
        console.warn('[ws] edge created before run loaded', { eventId: event.id, edgeId: event.edge.id });
      }
      store.addEdge(event.edge);
      return true;

    case 'edge.deleted':
      if (!store.run) {
        console.warn('[ws] edge deleted before run loaded', { eventId: event.id, edgeId: event.edgeId });
      }
      store.removeEdge(event.edgeId);
      return true;

    case 'handoff.sent': {
      if (!alreadySeen) {
        store.addHandoff(event.envelope);
      }
      if (isLive && store.run) {
        // Find edge between nodes
        const edges = Object.values(store.run.edges);
        const matchingEdge = edges.find(
          (e) =>
            (e.from === event.envelope.fromNodeId && e.to === event.envelope.toNodeId) ||
            (e.bidirectional &&
              e.from === event.envelope.toNodeId &&
              e.to === event.envelope.fromNodeId)
        );
        if (matchingEdge) {
          store.triggerHandoffAnimation(matchingEdge.id, event.envelope.fromNodeId, event.envelope.toNodeId);
        }
      }
      return true;
    }

    case 'message.user':
      if (event.message.nodeId) {
        store.addChatMessage({
          id: event.message.id,
          nodeId: event.message.nodeId,
          role: event.message.role,
          content: event.message.content,
          createdAt: event.message.createdAt,
        });
      }
      return true;

    case 'message.assistant.delta':
      if (isLive) {
        store.updateNode(event.nodeId, {
          connection: {
            status: 'connected',
            streaming: true,
            lastHeartbeatAt: event.ts,
            lastOutputAt: event.ts,
          },
        });
      }
      store.appendAssistantDelta(event.nodeId, event.delta, event.ts);
      return true;

    case 'message.assistant.final': {
      if (isLive) {
        const connectionStatus = event.status === 'interrupted' ? 'idle' : 'connected';
        store.updateNode(event.nodeId, {
          connection: {
            status: connectionStatus,
            streaming: false,
            lastHeartbeatAt: event.ts,
            lastOutputAt: event.ts,
          },
          lastActivityAt: event.ts,
        });
      }
      store.finalizeAssistantMessage(event.nodeId, event.content, event.ts, event.status, event.id);
      return true;
    }

    case 'message.assistant.thinking.delta':
      store.appendAssistantThinkingDelta(event.nodeId, event.delta, event.ts);
      return true;

    case 'message.assistant.thinking.final':
      store.finalizeAssistantThinking(event.nodeId, event.content, event.ts);
      return true;

    case 'tool.proposed': {
      const existing = store.toolEvents.find((entry) => entry.tool.id === event.tool.id);
      if (existing) {
        return true;
      }
      const toolEvent: ToolEvent = {
        id: event.id,
        nodeId: event.nodeId,
        tool: event.tool,
        status: 'proposed',
        timestamp: event.ts,
      };
      store.addToolEvent(toolEvent);
      return true;
    }

    case 'tool.started': {
      const existing = store.toolEvents.find((entry) => entry.tool.id === event.tool.id);
      if (existing) {
        store.updateToolEvent(event.tool.id, {
          status: 'started',
          tool: event.tool,
          timestamp: event.ts,
        });
        return true;
      }
      store.addToolEvent({
        id: event.id,
        nodeId: event.nodeId,
        tool: event.tool,
        status: 'started',
        timestamp: event.ts,
      });
      return true;
    }

    case 'tool.completed':
      store.updateToolEvent(event.toolId, {
        status: event.result.ok ? 'completed' : 'failed',
        result: event.result,
        error: event.error,
        timestamp: event.ts,
      });
      return true;

    case 'approval.requested':
      store.addApproval({
        approvalId: event.approvalId,
        nodeId: event.nodeId,
        tool: event.tool,
        context: event.context,
      });
      return true;

    case 'approval.resolved':
      store.removeApproval(event.approvalId);
      return true;

    case 'artifact.created':
      if (isLive) {
        store.addArtifact(event.artifact);
      }
      return true;

    case 'telemetry.usage':
      if (isLive) {
        const usage = event.usage;
        if (event.nodeId) {
          const node = store.getNode(event.nodeId);
          if (node) {
            store.updateNode(event.nodeId, { usage: addUsage(node.usage, usage) });
          }
        }
        if (store.run) {
          store.applyRunPatch({ usage: addUsage(store.run.usage, usage), updatedAt: event.ts });
        }
      }
      return true;

    default:
      return false;
  }
}
