/**
 * WebSocket client for real-time event streaming
 * Connects to the daemon and updates the store based on incoming events
 */

import type { EventEnvelope } from '@vuhlp/contracts';
import { applyEventToStore } from './event-handlers';

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

interface WebSocketClientOptions {
  url: string;
  runId: string;
  onConnectionChange?: (state: ConnectionState) => void;
  onEvent?: (event: EventEnvelope) => void;
}

const DEFAULT_WS_URL = 'ws://localhost:4000';
const DEBUG_WS = import.meta.env.VITE_DEBUG_WS === 'true';

type WsUrlSource = 'env:VITE_WS_URL' | 'env:VITE_API_URL' | 'window' | 'default';

const debugLog = (...args: unknown[]) => {
  if (DEBUG_WS) {
    console.log(...args);
  }
};

const debugWarn = (...args: unknown[]) => {
  if (DEBUG_WS) {
    console.warn(...args);
  }
};

function resolveEnvUrl(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getBrowserOrigin(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const origin = window.location?.origin;
  if (!origin || origin === 'null') {
    return null;
  }
  return origin;
}

function resolveWsBaseUrl(): { url: string; source: WsUrlSource } {
  const envWsUrl = resolveEnvUrl(import.meta.env.VITE_WS_URL);
  if (envWsUrl) {
    return { url: envWsUrl, source: 'env:VITE_WS_URL' };
  }
  const envApiUrl = resolveEnvUrl(import.meta.env.VITE_API_URL);
  if (envApiUrl) {
    return { url: envApiUrl, source: 'env:VITE_API_URL' };
  }
  const origin = getBrowserOrigin();
  if (origin) {
    return { url: origin, source: 'window' };
  }
  console.error('[ws] unable to resolve WebSocket base URL; falling back to default', {
    fallback: DEFAULT_WS_URL,
  });
  return { url: DEFAULT_WS_URL, source: 'default' };
}

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
  private onEvent?: (event: EventEnvelope) => void;

  constructor(options: WebSocketClientOptions) {
    this.url = options.url;
    this.runId = options.runId;
    this.onConnectionChange = options.onConnectionChange;
    this.onEvent = options.onEvent;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      debugLog('[ws] already connected');
      return;
    }

    this.onConnectionChange?.('connecting');
    debugLog('[ws] connecting to', this.url);

    this.ws = new WebSocket(`${this.url}/ws?runId=${encodeURIComponent(this.runId)}`);

    this.ws.onopen = () => {
      debugLog('[ws] connected');
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
      debugLog('[ws] disconnected');
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
      debugLog('[ws] max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    debugLog(`[ws] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  private handleEvent(event: EventEnvelope): void {
    if (this.onEvent) {
      this.onEvent(event);
      return;
    }
    debugLog('[ws] event:', event.type, event);
    const handled = applyEventToStore(event, { mode: 'live' });
    if (!handled) {
      debugLog('[ws] unhandled event type:', event.type);
    }
  }

  send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      debugWarn('[ws] cannot send - not connected');
    }
  }
}

// Singleton instance
let wsClient: WebSocketClient | null = null;

export function connectToRun(
  runId: string,
  onConnectionChange?: (state: ConnectionState) => void,
  onEvent?: (event: EventEnvelope) => void
): WebSocketClient {
  if (wsClient) {
    wsClient.disconnect();
  }

  const resolved = resolveWsBaseUrl();
  const wsUrl = normalizeWsUrl(resolved.url);
  debugLog('[ws] resolved base URL', { source: resolved.source, url: wsUrl });
  wsClient = new WebSocketClient({
    url: wsUrl,
    runId,
    onConnectionChange,
    onEvent,
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
