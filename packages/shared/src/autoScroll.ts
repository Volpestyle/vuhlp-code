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

  useEffect(() => {
    if (resetKey !== undefined) {
      setIsPinned(true);
    }
  }, [resetKey]);

  useEffect(() => {
    if (!enabled || !isPinned) return;
    scrollToEnd();
  }, [enabled, isPinned, scrollToEnd, updateKey]);

  return { isPinned, updatePinned };
}
