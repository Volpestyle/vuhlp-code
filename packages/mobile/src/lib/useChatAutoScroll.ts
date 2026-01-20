import { useCallback } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';
import { useAutoScrollState } from '@vuhlp/shared';

interface UseChatAutoScrollOptions {
  scrollRef: React.RefObject<ScrollView | null>;
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
  const scrollToEnd = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [scrollRef]);

  const { isPinned, updatePinned } = useAutoScrollState({
    enabled,
    threshold,
    updateKey,
    resetKey,
    scrollToEnd,
  });

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
      updatePinned(distanceFromBottom);
    },
    [updatePinned]
  );

  return { handleScroll, isPinned };
}
