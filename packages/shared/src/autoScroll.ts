import { useCallback, useEffect, useState } from "react";

export interface AutoScrollOptions {
  enabled?: boolean;
  threshold?: number;
  updateKey?: string;
  resetKey?: string;
  scrollToEnd: () => void;
}

export interface AutoScrollState {
  isPinned: boolean;
  updatePinned: (distanceFromBottom: number) => void;
  /** Force pin to bottom and scroll immediately - call this when user sends a message */
  forcePinnedAndScroll: () => void;
}

export function useAutoScrollState({
  enabled = true,
  threshold = 48,
  updateKey,
  resetKey,
  scrollToEnd,
}: AutoScrollOptions): AutoScrollState {
  const [isPinned, setIsPinned] = useState(true);

  const updatePinned = useCallback(
    (distanceFromBottom: number) => {
      setIsPinned(distanceFromBottom <= threshold);
    },
    [threshold]
  );

  const forcePinnedAndScroll = useCallback(() => {
    setIsPinned(true);
    // Use requestAnimationFrame to ensure DOM has updated before scrolling
    requestAnimationFrame(() => {
      scrollToEnd();
    });
  }, [scrollToEnd]);

  useEffect(() => {
    if (resetKey !== undefined) {
      setIsPinned(true);
    }
  }, [resetKey]);

  useEffect(() => {
    if (!enabled || !isPinned) return;
    scrollToEnd();
  }, [enabled, isPinned, scrollToEnd, updateKey]);

  return { isPinned, updatePinned, forcePinnedAndScroll };
}
