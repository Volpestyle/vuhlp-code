/**
 * WebSocket client for real-time event streaming
 * Connects to the daemon and updates the store based on incoming events
 */

import type { EventEnvelope, NodeState, EdgeState, Artifact, Envelope, ToolCall } from '@vuhlp/contracts';
import { useRunStore, type ToolEvent, type StallEvidence } from '../stores/runStore';

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

interface WebSocketClientOptions {
  url: string;
  runId: string;
  onConnectionChange?: (state: ConnectionState) => void;
}

const DEFAULT_WS_URL = 'ws://localhost:4000';

function normalizeWsUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return trimmed;
  }
  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice('http://'.length)}`;
  }
  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice('https://'.length)}`;
  }
  return `ws://${trimmed}`;
}

class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private runId: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private onConnectionChange?: (state: ConnectionState) => void;

  constructor(options: WebSocketClientOptions) {
    this.url = options.url;
    this.runId = options.runId;
    this.onConnectionChange = options.onConnectionChange;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log('[ws] already connected');
      return;
    }

    this.onConnectionChange?.('connecting');
    console.log('[ws] connecting to', this.url);

    this.ws = new WebSocket(`${this.url}/ws?runId=${encodeURIComponent(this.runId)}`);

    this.ws.onopen = () => {
      console.log('[ws] connected');
      this.reconnectAttempts = 0;
      this.onConnectionChange?.('connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as EventEnvelope;
        this.handleEvent(data);
      } catch (err) {
        console.error('[ws] failed to parse message:', err);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[ws] error:', error);
      this.onConnectionChange?.('error');
    };

    this.ws.onclose = () => {
      console.log('[ws] disconnected');
      this.onConnectionChange?.('disconnected');
      this.attemptReconnect();
    };
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[ws] max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[ws] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  private handleEvent(event: EventEnvelope): void {
    console.log('[ws] event:', event.type, event);

    const store = useRunStore.getState();

    switch (event.type) {
      case 'run.patch':
        if ('patch' in event) {
          store.applyRunPatch(event.patch);
        }
        break;

      case 'run.mode':
        if ('mode' in event && event.mode) {
          store.setOrchestrationMode(event.mode);
        }
        if ('globalMode' in event && event.globalMode) {
          store.setGlobalMode(event.globalMode);
        }
        break;

      case 'run.stalled':
        console.warn('[ws] run stalled:', event);
        store.updateRunStatus('paused');
        if ('evidence' in event) {
          store.setStall(event.evidence as StallEvidence);
        }
        break;

      case 'node.patch':
        if ('nodeId' in event && 'patch' in event) {
          store.updateNode(event.nodeId, event.patch as Partial<NodeState>);
        }
        break;

      case 'node.deleted':
        if ('nodeId' in event) {
          store.removeNode(event.nodeId);
        }
        break;

      case 'node.progress':
        if ('nodeId' in event) {
          const progressEvent = event as { nodeId: string; status?: string; summary?: string };
          store.updateNode(progressEvent.nodeId, {
            status: progressEvent.status as NodeState['status'],
            summary: progressEvent.summary,
            lastActivityAt: event.ts,
          });
        }
        break;

      case 'edge.created':
        if ('edge' in event) {
          store.addEdge(event.edge as EdgeState);
        }
        break;

      case 'edge.deleted':
        if ('edgeId' in event) {
          store.removeEdge(event.edgeId);
        }
        break;

      case 'handoff.sent':
        if ('envelope' in event) {
          store.addHandoff(event.envelope as Envelope);
        }
        break;

      case 'message.user':
        if ('message' in event && event.message.nodeId) {
          store.addChatMessage({
            id: event.message.id,
            nodeId: event.message.nodeId,
            role: event.message.role,
            content: event.message.content,
            createdAt: event.message.createdAt,
          });
        }
        break;

      case 'message.assistant.delta':
        if ('nodeId' in event) {
          store.updateNode(event.nodeId, {
            connection: { status: 'connected', streaming: true, lastHeartbeatAt: event.ts, lastOutputAt: event.ts },
          });
          if ('delta' in event) {
            store.appendAssistantDelta(event.nodeId, event.delta, event.ts);
          }
        }
        break;

      case 'message.assistant.final':
        if ('nodeId' in event) {
          store.updateNode(event.nodeId, {
            connection: { status: 'connected', streaming: false, lastHeartbeatAt: event.ts, lastOutputAt: event.ts },
            lastActivityAt: event.ts,
          });
          if ('content' in event) {
            store.finalizeAssistantMessage(event.nodeId, event.content, event.ts);
          }
        }
        break;

      case 'tool.proposed':
        if ('nodeId' in event && 'tool' in event) {
          const toolEvent: ToolEvent = {
            id: event.id,
            nodeId: event.nodeId,
            tool: event.tool as ToolCall,
            status: 'proposed',
            timestamp: event.ts,
          };
          store.addToolEvent(toolEvent);
          console.log('[ws] tool.proposed:', toolEvent);
        }
        break;

      case 'tool.started':
        if ('nodeId' in event && 'tool' in event) {
          const toolEvent: ToolEvent = {
            id: event.id,
            nodeId: event.nodeId,
            tool: event.tool as ToolCall,
            status: 'started',
            timestamp: event.ts,
          };
          store.addToolEvent(toolEvent);
          console.log('[ws] tool.started:', toolEvent);
        }
        break;

      case 'tool.completed':
        if ('nodeId' in event && 'toolId' in event) {
          const completedEvent = event as { nodeId: string; toolId: string; result: { ok: boolean }; error?: { message: string } };
          store.updateToolEvent(completedEvent.toolId, {
            status: completedEvent.result.ok ? 'completed' : 'failed',
            result: completedEvent.result,
            error: completedEvent.error,
            timestamp: event.ts,
          });
          console.log('[ws] tool.completed:', completedEvent);
        }
        break;

      case 'approval.requested':
        if ('approvalId' in event && 'nodeId' in event && 'tool' in event) {
          store.addApproval({
            approvalId: event.approvalId,
            nodeId: event.nodeId,
            tool: event.tool,
            context: 'context' in event ? event.context : undefined,
          });
        }
        break;

      case 'approval.resolved':
        if ('approvalId' in event) {
          store.removeApproval(event.approvalId);
        }
        break;

      case 'artifact.created':
        if ('artifact' in event) {
          store.addArtifact(event.artifact as Artifact);
        }
        break;

      default:
        console.log('[ws] unhandled event type:', event.type);
    }
  }

  send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('[ws] cannot send - not connected');
    }
  }
}

// Singleton instance
let wsClient: WebSocketClient | null = null;

export function connectToRun(runId: string, onConnectionChange?: (state: ConnectionState) => void): WebSocketClient {
  if (wsClient) {
    wsClient.disconnect();
  }

  const wsUrl = normalizeWsUrl(
    (import.meta.env.VITE_WS_URL as string | undefined) ??
      (import.meta.env.VITE_API_URL as string | undefined) ??
      DEFAULT_WS_URL
  );
  wsClient = new WebSocketClient({
    url: wsUrl,
    runId,
    onConnectionChange,
  });

  wsClient.connect();
  return wsClient;
}

export function disconnectFromRun(): void {
  if (wsClient) {
    wsClient.disconnect();
    wsClient = null;
  }
}

export function getWebSocketClient(): WebSocketClient | null {
  return wsClient;
}
