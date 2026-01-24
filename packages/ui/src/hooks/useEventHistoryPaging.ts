import { useCallback } from 'react';
import { getRunEvents } from '../lib/api';
import { applyEventToStore } from '../lib/event-handlers';
import { useRunStore } from '../stores/runStore';

const HISTORY_PAGE_SIZE = 200;

export function useEventHistoryPaging() {
  const runId = useRunStore((s) => s.run?.id ?? null);
  const eventHistory = useRunStore((s) => s.eventHistory);
  const setEventHistory = useRunStore((s) => s.setEventHistory);

  const loadOlder = useCallback(async () => {
    if (!runId) {
      setEventHistory({ error: 'No active run' });
      return;
    }
    if (eventHistory.loading || eventHistory.loadingOlder || !eventHistory.hasMore) {
      return;
    }
    if (!eventHistory.oldestCursor) {
      setEventHistory({ hasMore: false });
      return;
    }

    setEventHistory({ loadingOlder: true, error: null });
    console.info('[history] loading older events', { runId, before: eventHistory.oldestCursor });

    try {
      const response = await getRunEvents(runId, {
        limit: HISTORY_PAGE_SIZE,
        before: eventHistory.oldestCursor,
      });
      for (const event of response.events) {
        applyEventToStore(event, { mode: 'replay' });
      }
      setEventHistory({
        loadingOlder: false,
        hasMore: response.page.hasMore,
        oldestCursor: response.page.nextCursor,
        error: null,
      });
      console.info('[history] loaded older events', { runId, count: response.events.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[history] failed to load older events', { runId, message });
      setEventHistory({ loadingOlder: false, error: message });
    }
  }, [
    runId,
    eventHistory.loading,
    eventHistory.loadingOlder,
    eventHistory.hasMore,
    eventHistory.oldestCursor,
    setEventHistory,
  ]);

  return { ...eventHistory, loadOlder };
}
