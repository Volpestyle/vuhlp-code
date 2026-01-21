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

interface UseChatAutoScrollResult {
  handleScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  isPinned: boolean;
  onContentSizeChange: () => void;
  /** Force scroll to bottom - call this when user sends a message */
  scrollToBottom: () => void;
}

export function useChatAutoScroll({
  scrollRef,
  enabled = true,
  threshold = 48,
  updateKey,
  resetKey,
}: UseChatAutoScrollOptions): UseChatAutoScrollResult {
  const scrollToEnd = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [scrollRef]);

  const { isPinned, updatePinned, forcePinnedAndScroll } = useAutoScrollState({
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

  const onContentSizeChange = useCallback(() => {
    if (enabled && isPinned) {
      scrollToEnd();
    }
  }, [enabled, isPinned, scrollToEnd]);

  return { handleScroll, isPinned, onContentSizeChange, scrollToBottom: forcePinnedAndScroll };
}
