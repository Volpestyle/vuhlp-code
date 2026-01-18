import { useCallback, useEffect, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';

interface UseChatAutoScrollOptions {
  scrollRef: React.RefObject<ScrollView>;
  enabled?: boolean;
  threshold?: number;
  updateKey?: string;
  resetKey?: string;
}

export function useChatAutoScroll({
  scrollRef,
  enabled = true,
  threshold = 48,
  updateKey,
  resetKey,
}: UseChatAutoScrollOptions) {
  const [isPinned, setIsPinned] = useState(true);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
      setIsPinned(distanceFromBottom <= threshold);
    },
    [threshold]
  );

  useEffect(() => {
    if (!enabled || !isPinned) return;
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [enabled, isPinned, scrollRef, updateKey]);

  useEffect(() => {
    if (resetKey !== undefined) {
      setIsPinned(true);
    }
  }, [resetKey]);

  return { handleScroll, isPinned };
}
