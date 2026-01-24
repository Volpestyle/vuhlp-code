import { useCallback, useEffect, useState } from 'react';
import { getRunEvents } from '../lib/api';
import { applyEventToStore } from '../lib/event-handlers';
import { useRunStore } from '../stores/runStore';

const HISTORY_PAGE_SIZE = 200;

export function useRunEventHistory(
  runId: string | null
): { loading: boolean; error: string | null; retry: () => void } {
  const resetEventState = useRunStore((s) => s.resetEventState);
  const setEventHistory = useRunStore((s) => s.setEventHistory);
  const resetEventHistory = useRunStore((s) => s.resetEventHistory);
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
      resetEventHistory();
      return;
    }

    let cancelled = false;

    resetEventState();
    setLoading(true);
    setError(null);
    setEventHistory({ loading: true, error: null, hasMore: false, oldestCursor: null, loadingOlder: false });
    console.info('[history] loading run events', { runId, attempt });

    void getRunEvents(runId, { limit: HISTORY_PAGE_SIZE })
      .then((response) => {
        if (cancelled) return;
        for (const event of response.events) {
          applyEventToStore(event, { mode: 'replay' });
        }
        console.info('[history] loaded run events', { runId, count: response.events.length });
        setEventHistory({
          loading: false,
          error: null,
          hasMore: response.page.hasMore,
          oldestCursor: response.page.nextCursor,
          loadingOlder: false,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error('[history] failed to load run events', { runId, message });
        setError(message);
        setEventHistory({ loading: false, loadingOlder: false, error: message, hasMore: false, oldestCursor: null });
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [runId, resetEventState, setEventHistory, resetEventHistory, attempt]);

  return { loading, error, retry };
}
