import { useCallback, useEffect, useState } from 'react';
import { getRunEvents } from '../lib/api';
import { applyEventToStore } from '../lib/event-handlers';
import { useRunStore } from '../stores/runStore';

export function useRunEventHistory(
  runId: string | null
): { loading: boolean; error: string | null; retry: () => void } {
  const resetEventState = useRunStore((s) => s.resetEventState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setAttempt((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (!runId) {
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    resetEventState();
    setLoading(true);
    setError(null);
    console.info('[history] loading run events', { runId, attempt });

    void getRunEvents(runId)
      .then((events) => {
        if (cancelled) return;
        for (const event of events) {
          applyEventToStore(event, { mode: 'replay' });
        }
        console.info('[history] loaded run events', { runId, count: events.length });
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error('[history] failed to load run events', { runId, message });
        setError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [runId, resetEventState, attempt]);

  return { loading, error, retry };
}
