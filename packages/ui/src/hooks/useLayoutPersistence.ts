/**
 * Hook for persisting graph layout per run
 * Sends layout updates to the daemon so web + mobile stay in sync.
 */

import { useEffect, useRef } from 'react';
import type { GraphLayout } from '@vuhlp/contracts';
import { updateRun } from '../lib/api';
import { useRunStore } from '../stores/runStore';
import { useGraphStore } from '../stores/graph-store';

const PERSIST_DEBOUNCE_MS = 250;

export function useLayoutPersistence() {
  const run = useRunStore((s) => s.run);
  const layoutDirty = useGraphStore((s) => s.layoutDirty);
  const layoutUpdatedAt = useGraphStore((s) => s.layoutUpdatedAt);
  const debounceRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const lastPersistedAtRef = useRef<string | null>(null);

  useEffect(() => {
    lastPersistedAtRef.current = null;
    pendingRef.current = false;
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, [run?.id]);

  useEffect(() => {
    if (!run?.id) return;
    if (!layoutDirty) return;
    if (pendingRef.current && lastPersistedAtRef.current === layoutUpdatedAt) return;

    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
    }

    debounceRef.current = window.setTimeout(() => {
      const graphState = useGraphStore.getState();
      const activeRun = useRunStore.getState().run;
      if (!activeRun || activeRun.id !== run.id) return;
      if (graphState.currentRunId && graphState.currentRunId !== run.id) return;
      if (!graphState.layoutDirty) return;

      const positions: GraphLayout['positions'] = {};
      graphState.nodes.forEach((node) => {
        positions[node.id] = node.position;
      });

      const updatedAt = graphState.layoutUpdatedAt ?? new Date().toISOString();
      const layout: GraphLayout = {
        positions,
        viewport: graphState.viewport,
        updatedAt,
      };

      pendingRef.current = true;
      lastPersistedAtRef.current = updatedAt;
      console.debug('[layout-persistence] persisting layout', {
        runId: run.id,
        updatedAt,
        nodeCount: graphState.nodes.length,
      });

      updateRun(run.id, { layout })
        .then((updated) => {
          pendingRef.current = false;
          useRunStore.getState().setRun(updated);
        })
        .catch((error) => {
          pendingRef.current = false;
          lastPersistedAtRef.current = null;
          console.error('[layout-persistence] failed to persist layout', error);
        });
    }, PERSIST_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [run?.id, layoutDirty, layoutUpdatedAt]);
}
