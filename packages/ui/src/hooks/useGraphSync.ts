import { useEffect } from 'react';
import { useRunStore } from '../stores/runStore';
import { useGraphStore } from '../stores/graph-store';

export function useGraphSync(): void {
  const run = useRunStore((s) => s.run);
  const selectedNodeId = useRunStore((s) => s.ui.selectedNodeId);
  const selectedEdgeId = useRunStore((s) => s.ui.selectedEdgeId);
  const syncWithRun = useGraphStore((s) => s.syncWithRun);

  useEffect(() => {
    syncWithRun(run, selectedNodeId, selectedEdgeId);
  }, [run, selectedNodeId, selectedEdgeId, syncWithRun]);
}
