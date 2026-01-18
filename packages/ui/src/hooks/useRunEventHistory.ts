import { useEffect, useRef, useState } from 'react';
import { getRunEvents } from '../lib/api';
import { applyEventToStore } from '../lib/event-handlers';
import { useRunStore } from '../stores/runStore';

export function useRunEventHistory(runId: string | null): { loading: boolean } {
  const resetEventState = useRunStore((s) => s.resetEventState);
  const [loading, setLoading] = useState(false);
  const lastRunId = useRef<string | null>(null);

  useEffect(() => {
    if (!runId) {
      lastRunId.current = null;
      setLoading(false);
      return;
    }

    if (lastRunId.current === runId) {
      return;
    }

    lastRunId.current = runId;
    let cancelled = false;

    resetEventState();
    setLoading(true);

    void getRunEvents(runId)
      .then((events) => {
        if (cancelled) return;
        for (const event of events) {
          applyEventToStore(event, { mode: 'replay' });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error('[history] failed to load run events', { runId, message });
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [runId, resetEventState]);

  return { loading };
}
