/**
 * React hook for WebSocket connection management
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import type { EventEnvelope } from '@vuhlp/contracts';
import { applyEventToStore } from '../lib/event-handlers';
import { connectToRun, disconnectFromRun } from '../lib/websocket';
import { useRunStore, type WsConnectionStatus } from '../stores/runStore';

const DEBUG_WS = import.meta.env.VITE_DEBUG_WS === 'true';

const debugLog = (message: string, meta?: { count?: number; runId?: string; eventId?: string; type?: string }) => {
  if (!DEBUG_WS) return;
  if (meta) {
    console.log(message, meta);
  } else {
    console.log(message);
  }
};

export function useWebSocket(runId: string | null, bufferEvents?: boolean) {
  const [connectionState, setConnectionState] = useState<WsConnectionStatus>('disconnected');
  const setWsConnectionStatus = useRunStore((s) => s.setWsConnectionStatus);
  const bufferedEventsRef = useRef<EventEnvelope[]>([]);
  const bufferActiveRef = useRef<boolean>(bufferEvents ?? false);
  const lastBufferStateRef = useRef<boolean>(bufferActiveRef.current);

  const handleConnectionChange = useCallback(
    (state: WsConnectionStatus) => {
      setConnectionState(state);
      setWsConnectionStatus(state);
    },
    [setWsConnectionStatus]
  );

  const flushBufferedEvents = useCallback(() => {
    const buffered = bufferedEventsRef.current;
    if (buffered.length === 0) {
      return;
    }
    bufferedEventsRef.current = [];
    debugLog('[ws] flushing buffered events', { count: buffered.length, runId: runId ?? undefined });
    for (const event of buffered) {
      try {
        const handled = applyEventToStore(event, { mode: 'live', allowDuplicateHandoffAnimation: true });
        if (!handled && DEBUG_WS) {
          console.warn('[ws] unhandled buffered event', { type: event.type, eventId: event.id });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ws] failed to apply buffered event', { type: event.type, eventId: event.id, message });
      }
    }
  }, [runId]);

  const handleEvent = useCallback((event: EventEnvelope) => {
    if (bufferActiveRef.current) {
      if (bufferedEventsRef.current.length === 0) {
        debugLog('[ws] buffering events until history loads', { runId: runId ?? undefined });
      }
      bufferedEventsRef.current.push(event);
      return;
    }
    try {
      const handled = applyEventToStore(event, { mode: 'live', allowDuplicateHandoffAnimation: true });
      if (!handled && DEBUG_WS) {
        console.warn('[ws] unhandled event', { type: event.type, eventId: event.id });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ws] failed to apply event', { type: event.type, eventId: event.id, message });
    }
  }, [runId]);

  const connect = useCallback(() => {
    if (!runId) return;
    connectToRun(runId, handleConnectionChange, handleEvent);
  }, [runId, handleConnectionChange, handleEvent]);

  const disconnect = useCallback(() => {
    disconnectFromRun();
    setConnectionState('disconnected');
    setWsConnectionStatus('disconnected');
  }, [setWsConnectionStatus]);

  useEffect(() => {
    bufferActiveRef.current = bufferEvents ?? false;
    if (bufferActiveRef.current !== lastBufferStateRef.current) {
      if (bufferActiveRef.current) {
        bufferedEventsRef.current = [];
        debugLog('[ws] buffering enabled', { runId: runId ?? undefined });
      }
      lastBufferStateRef.current = bufferActiveRef.current;
      if (!bufferActiveRef.current) {
        flushBufferedEvents();
      }
    }
  }, [bufferEvents, flushBufferedEvents, runId]);

  useEffect(() => {
    bufferedEventsRef.current = [];
  }, [runId]);

  useEffect(() => {
    if (runId) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [runId, connect, disconnect]);

  return {
    connectionState,
    isConnected: connectionState === 'connected',
    connect,
    disconnect,
  };
}
