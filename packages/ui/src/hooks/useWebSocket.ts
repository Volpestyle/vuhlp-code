/**
 * React hook for WebSocket connection management
 */

import { useEffect, useState, useCallback } from 'react';
import { connectToRun, disconnectFromRun } from '../lib/websocket';

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export function useWebSocket(runId: string | null) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');

  const connect = useCallback(() => {
    if (!runId) return;
    connectToRun(runId, setConnectionState);
  }, [runId]);

  const disconnect = useCallback(() => {
    disconnectFromRun();
    setConnectionState('disconnected');
  }, []);

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
