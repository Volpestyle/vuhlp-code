import { useCallback, useEffect, useState } from 'react';
import { useRunStore } from '../stores/runStore';
import { createRun, getRun, listRuns } from '../lib/api';
import type { RunState } from '@vuhlp/contracts';

const RUN_STORAGE_KEY = 'vuhlp-active-run-id';

let bootstrapPromise: Promise<RunState> | null = null;
let bootstrapAttempt = 0;

function getBootstrapPromise(attempt: number, bootstrapper: () => Promise<RunState>): Promise<RunState> {
  if (bootstrapPromise && bootstrapAttempt === attempt) {
    console.info('[bootstrap] reusing in-flight bootstrap', { attempt });
    return bootstrapPromise;
  }
  bootstrapAttempt = attempt;
  bootstrapPromise = bootstrapper();
  return bootstrapPromise;
}

function resetBootstrapPromise(): void {
  bootstrapPromise = null;
}

export interface RunBootstrapState {
  loading: boolean;
  error: string | null;
  retry: () => void;
}

export function useRunBootstrap(): RunBootstrapState {
  const run = useRunStore((s) => s.run);
  const setRun = useRunStore((s) => s.setRun);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (run) {
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    console.info('[bootstrap] initializing run', { attempt });

    const bootstrapPromiseLocal = getBootstrapPromise(attempt, async () => {
        let nextRun: RunState | null = null;
        let storedRunId: string | null = null;
        let lastErrorMessage: string | null = null;

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
                lastErrorMessage = error instanceof Error ? error.message : String(error);
                console.warn('[bootstrap] failed to load run, using snapshot', error);
                nextRun = runs.find((item) => item.id === targetId) ?? runs[0];
              }
            }
          }
        } catch (error) {
          lastErrorMessage = error instanceof Error ? error.message : String(error);
          console.error('[bootstrap] failed to list runs', error);
        }

        if (!nextRun) {
          try {
            nextRun = await createRun();
          } catch (error) {
            lastErrorMessage = error instanceof Error ? error.message : String(error);
            console.error('[bootstrap] failed to create run', error);
          }
        }

        if (!nextRun) {
          throw new Error(lastErrorMessage ?? 'Unable to initialize a run. Please retry.');
        }

        return nextRun;
      });

    const attemptToken = attempt;

    bootstrapPromiseLocal
      .then((nextRun) => {
        if (bootstrapAttempt !== attemptToken) {
          console.warn('[bootstrap] skipping outdated bootstrap result', {
            attempt: attemptToken,
            currentAttempt: bootstrapAttempt
          });
          return;
        }
        // ALWAYS update the global store, even if unmounted.
        // This ensures the run created by the first effect (in Strict Mode) isn't lost.
        // The store is external to the component tree.
        setRun(nextRun);
        console.info('[bootstrap] run ready', { runId: nextRun.id });

        try {
          localStorage.setItem(RUN_STORAGE_KEY, nextRun.id);
        } catch (error) {
          console.warn('[bootstrap] failed to persist run selection', error);
        }

        // Update local state only if still mounted
        if (!cancelled) {
          setLoading(false);
        }
      })
      .catch((error) => {
        if (bootstrapAttempt !== attemptToken) {
          console.warn('[bootstrap] skipping outdated bootstrap error', {
            attempt: attemptToken,
            currentAttempt: bootstrapAttempt
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error('[bootstrap] bootstrapping failed', message);

        // Allow retry on failure
        resetBootstrapPromise();

        if (!cancelled) {
          setError(message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [run, setRun, attempt]);

  useEffect(() => {
    if (run?.id) {
      try {
        localStorage.setItem(RUN_STORAGE_KEY, run.id);
      } catch (error) {
        console.warn('[bootstrap] failed to persist run selection', error);
      }
    }
  }, [run?.id]);

  return { loading, error, retry };
}
