/**
 * React hook for WebSocket connection management
 */

import { useEffect, useState, useCallback } from 'react';
import { connectToRun, disconnectFromRun } from '../lib/websocket';
import { useRunStore, type WsConnectionStatus } from '../stores/runStore';

export function useWebSocket(runId: string | null) {
  const [connectionState, setConnectionState] = useState<WsConnectionStatus>('disconnected');
  const setWsConnectionStatus = useRunStore((s) => s.setWsConnectionStatus);

  const handleConnectionChange = useCallback(
    (state: WsConnectionStatus) => {
      setConnectionState(state);
      setWsConnectionStatus(state);
    },
    [setWsConnectionStatus]
  );

  const connect = useCallback(() => {
    if (!runId) return;
    connectToRun(runId, handleConnectionChange);
  }, [runId, handleConnectionChange]);

  const disconnect = useCallback(() => {
    disconnectFromRun();
    setConnectionState('disconnected');
    setWsConnectionStatus('disconnected');
  }, [setWsConnectionStatus]);

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
