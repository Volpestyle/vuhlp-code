/**
 * Hook for persisting graph layout per run
 * Automatically loads layout when run changes and saves on unmount
 */

import { useEffect } from 'react';
import { useRunStore } from '../stores/runStore';
import { useGraphStore } from '../stores/graph-store';

export function useLayoutPersistence() {
  const run = useRunStore((s) => s.run);
  const loadLayoutForRun = useGraphStore((s) => s.loadLayoutForRun);
  const saveLayoutForRun = useGraphStore((s) => s.saveLayoutForRun);
  const currentRunId = useGraphStore((s) => s.currentRunId);

  // Load layout when run changes
  useEffect(() => {
    if (run?.id && run.id !== currentRunId) {
      console.log('[layout-persistence] run changed, loading layout:', run.id);
      loadLayoutForRun(run.id);
    }
  }, [run?.id, currentRunId, loadLayoutForRun]);

  // Save layout on unmount or before page unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      saveLayoutForRun();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      // Save on unmount
      saveLayoutForRun();
    };
  }, [saveLayoutForRun]);
}
