import { useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import type { TimelineEvent } from '../stores/runStore';

interface UseChatAutoScrollOptions {
  scrollRef: RefObject<HTMLElement>;
  timeline: TimelineEvent[];
  enabled?: boolean;
  threshold?: number;
  updateKey?: string;
  resetKey?: string;
}

const buildTimelineUpdateKey = (timeline: TimelineEvent[]): string => {
  const lastItem = timeline[timeline.length - 1];
  if (!lastItem) return '';
  if (lastItem.type === 'message') {
    const thinkingLength = lastItem.data.thinking?.length ?? 0;
    return `${lastItem.data.id}-${lastItem.data.createdAt}-${lastItem.data.content.length}-${thinkingLength}`;
  }
  return `${lastItem.data.id}-${lastItem.data.timestamp}`;
};

export function useChatAutoScroll({
  scrollRef,
  timeline,
  enabled = true,
  threshold = 48,
  updateKey,
  resetKey,
}: UseChatAutoScrollOptions): void {
  const [isPinned, setIsPinned] = useState(true);
  const timelineKey = useMemo(() => buildTimelineUpdateKey(timeline), [timeline]);
  const combinedKey = useMemo(
    () => `${timelineKey}::${updateKey ?? ''}`,
    [timelineKey, updateKey]
  );

  useEffect(() => {
    if (resetKey !== undefined) {
      setIsPinned(true);
    }
  }, [resetKey]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const handleScroll = () => {
      const distanceFromBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      setIsPinned(distanceFromBottom <= threshold);
    };

    handleScroll();
    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => element.removeEventListener('scroll', handleScroll);
  }, [scrollRef, threshold]);

  useEffect(() => {
    if (!enabled || !isPinned) return;
    const element = scrollRef.current;
    if (!element) return;
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }, [enabled, isPinned, scrollRef, combinedKey]);
}
