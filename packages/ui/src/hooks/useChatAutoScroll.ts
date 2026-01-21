import { useCallback, useEffect, useMemo } from 'react';
import type { RefObject } from 'react';
import type { TimelineEvent } from '../stores/runStore';
import { buildTimelineUpdateKey, useAutoScrollState } from '@vuhlp/shared';

interface UseChatAutoScrollOptions {
  scrollRef: RefObject<HTMLElement | null>;
  timeline: TimelineEvent[];
  enabled?: boolean;
  threshold?: number;
  updateKey?: string;
  resetKey?: string;
}

interface UseChatAutoScrollResult {
  /** Force scroll to bottom - call this when user sends a message */
  scrollToBottom: () => void;
}

export function useChatAutoScroll({
  scrollRef,
  timeline,
  enabled = true,
  threshold = 48,
  updateKey,
  resetKey,
}: UseChatAutoScrollOptions): UseChatAutoScrollResult {
  const timelineKey = useMemo(() => buildTimelineUpdateKey(timeline), [timeline]);
  const combinedKey = useMemo(
    () => `${timelineKey}::${updateKey ?? ''}`,
    [timelineKey, updateKey]
  );

  const scrollToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }, [scrollRef]);

  const { updatePinned, forcePinnedAndScroll } = useAutoScrollState({
    enabled,
    threshold,
    updateKey: combinedKey,
    resetKey,
    scrollToEnd,
  });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const handleScroll = () => {
      const distanceFromBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      updatePinned(distanceFromBottom);
    };

    handleScroll();
    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => element.removeEventListener('scroll', handleScroll);
  }, [scrollRef, updatePinned]);

  return { scrollToBottom: forcePinnedAndScroll };
}
