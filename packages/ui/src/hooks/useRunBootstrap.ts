import { useEffect, useRef } from 'react';
import { useRunStore } from '../stores/runStore';
import { createRun, getRun, listRuns } from '../lib/api';
import type { RunState } from '@vuhlp/contracts';

const RUN_STORAGE_KEY = 'vuhlp-active-run-id';

export function useRunBootstrap(): void {
  const run = useRunStore((s) => s.run);
  const setRun = useRunStore((s) => s.setRun);
  const initializing = useRef(false);

  useEffect(() => {
    if (run || initializing.current) {
      return;
    }
    initializing.current = true;

    const bootstrap = async () => {
      let nextRun: RunState | null = null;
      let storedRunId: string | null = null;

      try {
        storedRunId = localStorage.getItem(RUN_STORAGE_KEY);
      } catch (error) {
        console.warn('[bootstrap] local storage unavailable', error);
      }

      try {
        const runs = await listRuns();
        if (runs.length === 0) {
          nextRun = await createRun();
        } else {
          const sorted = [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          const targetId =
            storedRunId && runs.some((item) => item.id === storedRunId)
              ? storedRunId
              : (sorted[0]?.id ?? runs[0]?.id ?? null);
          if (targetId) {
            try {
              nextRun = await getRun(targetId);
            } catch (error) {
              console.warn('[bootstrap] failed to load run, using snapshot', error);
              nextRun = runs.find((item) => item.id === targetId) ?? runs[0];
            }
          }
        }
      } catch (error) {
        console.error('[bootstrap] failed to list runs', error);
      }

      if (!nextRun) {
        try {
          nextRun = await createRun();
        } catch (error) {
          console.error('[bootstrap] failed to create run', error);
        }
      }

      if (nextRun) {
        setRun(nextRun);
        try {
          localStorage.setItem(RUN_STORAGE_KEY, nextRun.id);
        } catch (error) {
          console.warn('[bootstrap] failed to persist run selection', error);
        }
      }

      initializing.current = false;
    };

    void bootstrap();
  }, [run, setRun]);

  useEffect(() => {
    if (run?.id) {
      try {
        localStorage.setItem(RUN_STORAGE_KEY, run.id);
      } catch (error) {
        console.warn('[bootstrap] failed to persist run selection', error);
      }
    }
  }, [run?.id]);
}
