import { useEffect, useRef } from 'react';
import { api } from './api';
import { useGraphStore } from '@/stores/graph-store';

const SAVE_DEBOUNCE_MS = 400;

export function useLayoutPersistence(runId: string | undefined) {
  const layoutDirty = useGraphStore((s) => s.layoutDirty);
  const layoutUpdatedAt = useGraphStore((s) => s.layoutUpdatedAt);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPersistedAtRef = useRef<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    if (!layoutDirty) return;
    if (pendingRef.current && lastPersistedAtRef.current === layoutUpdatedAt) return;

    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
    }

    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      const graphState = useGraphStore.getState();
      if (!graphState.layoutDirty) return;
      if (!graphState.run || graphState.run.id !== runId) return;

      const positions: Record<string, { x: number; y: number }> = {};
      for (const node of graphState.nodes) {
        positions[node.id] = node.position;
      }
      const updatedAt = graphState.layoutUpdatedAt ?? new Date().toISOString();
      const layout = { positions, viewport: graphState.viewport, updatedAt };

      console.info('[layout] persisting graph layout', {
        runId,
        nodes: Object.keys(positions).length,
      });

      void api
        .updateRun(runId, { layout })
        .then(() => {
          const latestUpdatedAt = useGraphStore.getState().layoutUpdatedAt;
          if (latestUpdatedAt !== updatedAt) {
            return;
          }
          lastPersistedAtRef.current = updatedAt;
          useGraphStore.setState({ layoutDirty: false, layoutUpdatedAt: updatedAt });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[layout] failed to persist layout', { runId, message });
        });
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current);
      }
    };
  }, [runId, layoutDirty, layoutUpdatedAt]);
}
