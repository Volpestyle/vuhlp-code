import { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  useWindowDimensions,
  Keyboard,
  ActionSheetIOS,
  Alert,
  Platform,
  type KeyboardEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  useSharedValue,
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
  withTiming,
  runOnJS,
  useAnimatedKeyboard,
  type EasingFunction,
  type EasingFunctionFactory,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Clock, ArrowUp } from 'iconoir-react-native';
import {
  useGraphStore,
  type ChatMessage,
  type ToolEvent,
  type TurnStatusEvent,
} from '@/stores/graph-store';
import type { Envelope } from '@vuhlp/contracts';
import { api } from '@/lib/api';
import { useChatAutoScroll } from '@/lib/useChatAutoScroll';
import { ThinkingSpinner } from '@vuhlp/spinners/native';
import { MarkdownMessage } from '@/components/MarkdownMessage';
import { MediaPickerDrawer } from '@/components/MediaPickerDrawer';
import { colors, getStatusColor, fontFamily } from '@/lib/theme';
import { createLocalId } from '@/lib/ids';
import {
  buildTimeline,
  buildTimelineUpdateKey,
  formatClockTime,
  formatTurnSummary,
  type TimelineItem,
} from '@vuhlp/shared';

const MIN_HEIGHT = 120;
const SNAP_THRESHOLD = 50;
const DEFAULT_KEYBOARD_DURATION_MS = 250;

type KeyboardEasingName = 'linear' | 'easeIn' | 'easeOut' | 'easeInEaseOut' | 'keyboard';

const normalizeKeyboardEasing = (easing?: string): KeyboardEasingName => {
  switch (easing) {
    case 'linear':
      return 'linear';
    case 'easeIn':
      return 'easeIn';
    case 'easeOut':
      return 'easeOut';
    case 'easeInEaseOut':
      return 'easeInEaseOut';
    case 'keyboard':
      return 'keyboard';
    default:
      return 'keyboard';
  }
};

const resolveKeyboardEasing = (easing: KeyboardEasingName): EasingFunction | EasingFunctionFactory => {
  'worklet';
  switch (easing) {
    case 'linear':
      return Easing.linear;
    case 'easeIn':
      return Easing.in(Easing.ease);
    case 'easeOut':
      return Easing.out(Easing.ease);
    case 'easeInEaseOut':
      return Easing.inOut(Easing.ease);
    case 'keyboard':
    default:
      return Easing.bezier(0.25, 0.1, 0.25, 1);
  }
};

const isHandoffToolName = (name: string): boolean =>
  name === 'send_handoff' || name === 'receive_handoff';

const isHandoffToolEvent = (event: ToolEvent): boolean => isHandoffToolName(event.tool.name);

const buildReceiveHandoffToolEvent = (handoff: Envelope): ToolEvent => {
  const toolId = `handoff-${handoff.id}`;
  const payload = handoff.payload;
  const args: {
    envelopeId: string;
    from: string;
    to: string;
    message: string;
    structured?: Envelope['payload']['structured'];
    artifacts?: Envelope['payload']['artifacts'];
    status?: Envelope['payload']['status'];
    response?: Envelope['payload']['response'];
    contextRef?: string;
  } = {
    envelopeId: handoff.id,
    from: handoff.fromNodeId,
    to: handoff.toNodeId,
    message: payload.message,
  };

  if (payload.structured) {
    args.structured = payload.structured;
  }
  if (payload.artifacts) {
    args.artifacts = payload.artifacts;
  }
  if (payload.status) {
    args.status = payload.status;
  }
  if (payload.response) {
    args.response = payload.response;
  }
  if (handoff.contextRef) {
    args.contextRef = handoff.contextRef;
  }

  return {
    id: toolId,
    nodeId: handoff.toNodeId,
    tool: {
      id: toolId,
      name: 'receive_handoff',
      args,
    },
    status: 'completed',
    timestamp: handoff.createdAt,
  };
};

export function NodeInspector() {
  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [restingInset, setRestingInset] = useState(insets.bottom);
  const maxHeight = screenHeight * 0.7;
  const baseInset = restingInset;
  const isIOS = Platform.OS === 'ios';

  // Calculate offsets
  // Expanded: offset 0 (visible height = maxHeight)
  // Collapsed: offset = maxHeight - MIN_HEIGHT
  const minTranslateY = 0;
  const maxTranslateY = maxHeight - MIN_HEIGHT;
  const closedTranslateY = maxHeight + MIN_HEIGHT;

  const run = useGraphStore((s) => s.run);
  const nodes = useGraphStore((s) => s.nodes);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const inspectorOpen = useGraphStore((s) => s.inspectorOpen);
  const chatMessages = useGraphStore((s) => s.chatMessages);
  const toolEvents = useGraphStore((s) => s.toolEvents);
  const turnStatusEvents = useGraphStore((s) => s.turnStatusEvents);
  const recentHandoffs = useGraphStore((s) => s.recentHandoffs);
  const setInspectorOpen = useGraphStore((s) => s.setInspectorOpen);
  const addChatMessage = useGraphStore((s) => s.addChatMessage);
  const updateChatMessageStatus = useGraphStore((s) => s.updateChatMessageStatus);
  const clearNodeMessages = useGraphStore((s) => s.clearNodeMessages);

  const [messageText, setMessageText] = useState('');
  const [messageError, setMessageError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'chat' | 'details'>('chat');
  const [mediaPickerVisible, setMediaPickerVisible] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);
  const sendLongPressRef = useRef(false);
  const keyboardConfigWarnedRef = useRef(false);

  const [displayNode, setDisplayNode] = useState(nodes.find((n) => n.selected) || null);

  // Preserve the resting safe-area inset so it doesn't collapse during keyboard transitions.
  useEffect(() => {
    setRestingInset((current) => (insets.bottom > current ? insets.bottom : current));
  }, [insets.bottom]);

  // Sync display node with selection, but keep old one while closing
  useEffect(() => {
    const current = nodes.find((n) => n.id === selectedNodeId);
    if (current) {
      setDisplayNode(current);
    }
  }, [nodes, selectedNodeId]);

  const selectedNode = displayNode;
  const nodeMessages = selectedNode?.id ? chatMessages[selectedNode.id] ?? [] : [];
  const nodeToolEvents = useMemo(() => {
    if (!selectedNode?.id) return [];
    return toolEvents.filter((event) => event.nodeId === selectedNode.id);
  }, [toolEvents, selectedNode?.id]);
  const incomingHandoffs = useMemo(
    () => recentHandoffs.filter((handoff) => handoff.toNodeId === selectedNode?.id),
    [recentHandoffs, selectedNode?.id]
  );
  const incomingHandoffTools = useMemo(
    () => incomingHandoffs.map((handoff) => buildReceiveHandoffToolEvent(handoff)),
    [incomingHandoffs]
  );
  const combinedToolEvents = useMemo(
    () => {
      const combined = [...nodeToolEvents, ...incomingHandoffTools];
      // Debug duplication
      const counts: Record<string, number> = {};
      for (const e of combined) {
        const k = `${e.tool.name}-${e.timestamp}`;
        counts[k] = (counts[k] || 0) + 1;
        if (counts[k] > 1 && e.tool.name === 'send_handoff') {
          console.warn('[inspector] duplicate send_handoff detected', e);
        }
      }
      return combined;
    },
    [nodeToolEvents, incomingHandoffTools]
  );
  const nodeStatusEvents = useMemo(() => {
    if (!selectedNode?.id) return [];
    return turnStatusEvents.filter((event) => event.nodeId === selectedNode.id);
  }, [turnStatusEvents, selectedNode?.id]);
  const timeline = useMemo(
    () => buildTimeline(nodeMessages, combinedToolEvents, nodeStatusEvents),
    [nodeMessages, combinedToolEvents, nodeStatusEvents]
  );
  const isRunning = selectedNode?.status === 'running';
  const isStreaming = useMemo(() => {
    const lastMessage = [...timeline].reverse().find((item) => item.type === 'message');
    return Boolean(
      lastMessage?.type === 'message' &&
        (lastMessage.data.streaming || lastMessage.data.thinkingStreaming)
    );
  }, [timeline]);

  // Include running/streaming state so scroll triggers when loading spinner appears
  const autoScrollKey = useMemo(
    () => `${buildTimelineUpdateKey(timeline)}-${isRunning}-${isStreaming}`,
    [timeline, isRunning, isStreaming]
  );
  const { handleScroll } = useChatAutoScroll({
    scrollRef: scrollViewRef,
    enabled: activeTab === 'chat',
    updateKey: autoScrollKey,
    resetKey: selectedNode?.id ?? '',
  });

  // Animation values
  const translateY = useSharedValue(maxTranslateY); // Start collapsed
  const context = useSharedValue({ y: 0 });
  const isClosingRef = useRef(false);
  const previousSelectedNodeId = useRef<string | null>(null);
  const previousInspectorOpen = useRef(inspectorOpen);

  const selectNode = useGraphStore((s) => s.selectNode);

  const finalizeClose = useCallback(() => {
    isClosingRef.current = false;
    // Clear display node only after animation finishes
    if (!inspectorOpen) {
      setDisplayNode(null);
    }
  }, [inspectorOpen]);

  // Reset to collapsed state when node changes or opens.
  useEffect(() => {
    const wasOpen = previousInspectorOpen.current;
    const nodeChanged = previousSelectedNodeId.current !== selectedNode?.id;
    previousInspectorOpen.current = inspectorOpen;
    previousSelectedNodeId.current = selectedNode?.id ?? null;

    if (!selectedNode) {
      return;
    }

    if (inspectorOpen && (nodeChanged || !wasOpen)) {
      isClosingRef.current = false;
      translateY.value = maxTranslateY;
    }
  }, [inspectorOpen, selectedNode, maxTranslateY]);

  useEffect(() => {
    // If not open and no closing animation pending, do nothing
    // If it *was* open and now isn't, animate close
    if (inspectorOpen || isClosingRef.current || !displayNode) {
      return;
    }

    isClosingRef.current = true;
    translateY.value = withSpring(
      closedTranslateY,
      { damping: 50, stiffness: 200 },
      (finished) => {
        if (finished) {
          runOnJS(finalizeClose)();
        }
      }
    );
  }, [closedTranslateY, finalizeClose, inspectorOpen, displayNode]);

  useEffect(() => {
    setMessageText('');
    setMessageError(null);
  }, [selectedNode?.id]);

  const keyboard = useAnimatedKeyboard();
  const keyboardTarget = useSharedValue(0);
  const keyboardDuration = useSharedValue(DEFAULT_KEYBOARD_DURATION_MS);
  const keyboardEasing = useSharedValue<KeyboardEasingName>('keyboard');

  useEffect(() => {
    if (!isIOS) {
      return;
    }

    const updateKeyboardConfig = (event: KeyboardEvent, targetHeight: number, source: string) => {
      if (!Number.isFinite(targetHeight)) {
        console.error('[inspector] keyboard event missing height', { source });
        return;
      }

      keyboardTarget.value = targetHeight;

      const duration =
        typeof event.duration === 'number' && event.duration > 0
          ? event.duration
          : DEFAULT_KEYBOARD_DURATION_MS;

      if ((!event.duration || !event.easing) && !keyboardConfigWarnedRef.current) {
        console.warn('[inspector] keyboard animation config missing, using defaults');
        keyboardConfigWarnedRef.current = true;
      }

      keyboardDuration.value = duration;
      keyboardEasing.value = normalizeKeyboardEasing(event.easing);
    };

    const showSub = Keyboard.addListener('keyboardWillShow', (event) => {
      updateKeyboardConfig(event, event.endCoordinates.height, 'show');
    });
    const hideSub = Keyboard.addListener('keyboardWillHide', (event) => {
      updateKeyboardConfig(event, 0, 'hide');
    });
    const changeSub = Keyboard.addListener('keyboardWillChangeFrame', (event) => {
      updateKeyboardConfig(event, event.endCoordinates.height, 'change');
    });

    return () => {
      showSub.remove();
      hideSub.remove();
      changeSub.remove();
    };
  }, [isIOS, keyboardDuration, keyboardEasing, keyboardTarget]);

  const keyboardAnimatedHeight = useDerivedValue(() => {
    if (isIOS) {
      const duration =
        keyboardDuration.value > 0 ? keyboardDuration.value : DEFAULT_KEYBOARD_DURATION_MS;
      const easing = resolveKeyboardEasing(keyboardEasing.value);
      return withTiming(keyboardTarget.value, { duration, easing });
    }

    return withSpring(keyboard.height.value, {
      dampingRatio: 0.9,
      overshootClamping: true,
    });
  }, [isIOS]);
  const safeInset = useDerivedValue(() => baseInset, [baseInset]);
  const keyboardBottom = useDerivedValue(() => {
    return Math.max(keyboardAnimatedHeight.value - safeInset.value, 0);
  });
  const bottomSpacerStyle = useAnimatedStyle(() => {
    return {
      height: safeInset.value,
    };
  });

  useEffect(() => {
    if (!inspectorOpen) {
      Keyboard.dismiss();
    }
  }, [inspectorOpen]);

  const handleClose = useCallback(() => {
    if (!inspectorOpen) {
      return;
    }
    Keyboard.dismiss();
    // Clear selection immediately when manually closing
    selectNode(null);
  }, [inspectorOpen, selectNode]);

  // Gestures
  const dragGesture = Gesture.Pan()
    .onStart(() => {
      context.value = { y: translateY.value };
    })
    .onUpdate((e) => {
      // Allow dragging slightly above min (resistance) and below max
      translateY.value = Math.max(
        minTranslateY - 50, // Resistance up
        Math.min(e.translationY + context.value.y, maxTranslateY + 100) // Drag down to close
      );
    })
    .onEnd((e) => {
      // Velocity check for snapping
      if (e.velocityY > 500) {
        // Fling down
        // If we are already near bottom, close it
        if (translateY.value > maxTranslateY - 50) {
           runOnJS(handleClose)();
        } else {
           // Snap to collapsed
           translateY.value = withSpring(maxTranslateY, { velocity: e.velocityY, damping: 50, stiffness: 200 });
        }
      } else if (e.velocityY < -500) {
        // Fling up -> Expand
        translateY.value = withSpring(minTranslateY, { velocity: e.velocityY, damping: 50, stiffness: 200 });
      } else {
        // Drag release - snap to nearest
        // If dragged significantly below maxTranslateY -> Close
        if (translateY.value > maxTranslateY + SNAP_THRESHOLD) {
          runOnJS(handleClose)();
        } else {
           const midPoint = (minTranslateY + maxTranslateY) / 2;
           if (translateY.value > midPoint) {
             translateY.value = withSpring(maxTranslateY, { damping: 50, stiffness: 200 });
           } else {
             translateY.value = withSpring(minTranslateY, { damping: 50, stiffness: 200 });
           }
        }
      }
    });

  const animatedStyle = useAnimatedStyle(() => {
    return {
      height: maxHeight, // Fixed layout height
      bottom: keyboardBottom.value,
      transform: [
        { translateY: translateY.value },
      ],
    };
  }, [maxHeight]);

  const sendMessage = useCallback(
    async (messageId: string, content: string, interrupt: boolean) => {
      if (!run || !selectedNode) {
        const errorText = 'Start a run to send messages.';
        console.warn('[inspector] cannot send message without active run');
        setMessageError(errorText);
        if (selectedNode) {
          updateChatMessageStatus(selectedNode.id, messageId, {
            pending: false,
            sendError: errorText,
          });
        }
        return;
      }

      try {
        await api.sendMessage(run.id, selectedNode.id, content, interrupt);
        updateChatMessageStatus(selectedNode.id, messageId, { pending: false });
      } catch (err) {
        const errorText =
          err instanceof Error ? err.message : 'Failed to send message.';
        console.error('[inspector] failed to send message:', err);
        updateChatMessageStatus(selectedNode.id, messageId, {
          pending: false,
          sendError: errorText,
        });
      }
    },
    [run, selectedNode, updateChatMessageStatus] // selectedNodeId -> selectedNode
  );

  const handleResetContext = useCallback(() => {
    if (!selectedNode?.id) return;
    clearNodeMessages(selectedNode.id);
    setMessageText('');
    setMessageError(null);
    if (!run) {
      const errorText = 'Start a run to reset context.';
      console.warn('[inspector] cannot reset context without active run');
      setMessageError(errorText);
      return;
    }
    api.resetNode(run.id, selectedNode.id).catch((err) => {
      console.error('[inspector] failed to reset context:', err);
      setMessageError('Failed to reset context.');
    });
  }, [clearNodeMessages, run, selectedNode]);

  const handleOpenMediaPicker = useCallback(() => {
    Keyboard.dismiss();
    setMediaPickerVisible(true);
  }, []);

  const handleCloseMediaPicker = useCallback(() => {
    setMediaPickerVisible(false);
  }, []);

  const handleSelectCamera = useCallback(() => {
    // TODO: Implement camera capture
    console.log('[inspector] camera selected - implementation pending');
  }, []);

  const handleSelectPhotos = useCallback(() => {
    // TODO: Implement photo library picker
    console.log('[inspector] photos selected - implementation pending');
  }, []);

  const handleSelectFiles = useCallback(() => {
    // TODO: Implement file picker
    console.log('[inspector] files selected - implementation pending');
  }, []);

  const handleSendMessage = useCallback(
    (interrupt: boolean) => {
      const content = (messageText || '').trim();
      if (!content || !selectedNode?.id) return;

      const resetCommands = selectedNode?.session?.resetCommands ?? ['/new', '/clear'];
      const normalized = content.toLowerCase();
      if (resetCommands.some((command) => command.toLowerCase() === normalized)) {
        handleResetContext();
        return;
      }

      if (!run) {
        const errorText = 'Start a run to send messages.';
        console.warn('[inspector] cannot send message without active run');
        setMessageError(errorText);
        return;
      }

      const messageId = createLocalId();
      const message: ChatMessage = {
        id: messageId,
        nodeId: selectedNode.id,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
        pending: true,
        interrupt,
      };

      addChatMessage(message);
      setMessageText('');
      setMessageError(null);
      void sendMessage(messageId, content, interrupt);
    },
    [messageText, selectedNode, run, addChatMessage, sendMessage, handleResetContext]
  );

  const canSend = Boolean((messageText || '').trim());

  const handlePrimaryPress = useCallback(() => {
    if (sendLongPressRef.current) {
      sendLongPressRef.current = false;
      return;
    }
    handleSendMessage(Boolean(isRunning));
  }, [handleSendMessage, isRunning]);

  const handleQueueLongPress = useCallback(() => {
    if (!canSend || !isRunning) {
      return;
    }

    sendLongPressRef.current = true;

    const queueMessage = () => {
      sendLongPressRef.current = false;
      console.log('[inspector] queueing message');
      handleSendMessage(false);
    };
    const cancelQueue = () => {
      sendLongPressRef.current = false;
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: 'Send options',
          options: ['Queue', 'Cancel'],
          cancelButtonIndex: 1,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) {
            queueMessage();
          } else {
            cancelQueue();
          }
        }
      );
      return;
    }

    Alert.alert('Send options', 'Choose how to deliver this message.', [
      { text: 'Queue', onPress: queueMessage },
      { text: 'Cancel', style: 'cancel', onPress: cancelQueue },
    ]);
  }, [canSend, handleSendMessage, isRunning]);

  const handleRetry = useCallback(
    (message: ChatMessage) => {
      if (!selectedNode?.id) return;
      updateChatMessageStatus(selectedNode.id, message.id, {
        pending: true,
        sendError: undefined,
      });
      setMessageError(null);
      void sendMessage(message.id, message.content, message.interrupt ?? true);
    },
    [selectedNode, updateChatMessageStatus, sendMessage]
  );

  if (!selectedNode) {
    return null;
  }

  return (
    <>
    <Animated.View
      pointerEvents={inspectorOpen ? 'auto' : 'none'}
      style={[styles.container, animatedStyle]}
    >
      {/* Draggable handle and header area */}
      <GestureDetector gesture={dragGesture}>
        <Animated.View>
          {/* Handle */}
          <View style={styles.handleContainer}>
            <View style={styles.handle} />
          </View>

          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: getStatusColor(selectedNode.status) },
                ]}
              />
              <Text style={styles.title} numberOfLines={1}>
                {selectedNode.label}
              </Text>
            </View>
            <Pressable onPress={handleClose} style={styles.closeButton}>
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>

          {/* Tabs */}
          <View style={styles.tabs}>
            <Pressable
              style={[styles.tab, activeTab === 'chat' && styles.tabActive]}
              onPress={() => setActiveTab('chat')}
            >
              <Text style={[styles.tabText, activeTab === 'chat' && styles.tabTextActive]}>
                Chat
              </Text>
            </Pressable>
            <Pressable
              style={[styles.tab, activeTab === 'details' && styles.tabActive]}
              onPress={() => setActiveTab('details')}
            >
              <Text style={[styles.tabText, activeTab === 'details' && styles.tabTextActive]}>
                Details
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      </GestureDetector>

      {/* Content - outside gesture detector for text selection */}
      {activeTab === 'chat' ? (
        <View style={styles.chatContainer}>
          <ScrollView
            ref={scrollViewRef}
            style={styles.messagesContainer}
            contentContainerStyle={styles.messagesContent}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
          >
            {timeline.length === 0 && selectedNode.status !== 'running' ? (
              <Text style={styles.emptyText}>
                Start a conversation with {selectedNode.label}
              </Text>
            ) : (
              <>
                {timeline.map((item) => (
                  <TimelineItem
                    key={`${item.type}-${item.data.id}`}
                    item={item}
                    onRetry={handleRetry}
                  />
                ))}
                {isRunning && !isStreaming && (
                  <View style={styles.thinkingPlaceholder}>
                    <View style={styles.thinkingHeader}>
                      <Text style={styles.thinkingRole}>assistant</Text>
                      <View style={styles.metaItem}>
                        <ThinkingSpinner size="sm" variant="assemble" color="#4de6a8" />
                        <Text style={styles.metaTextThinking}>thinking</Text>
                      </View>
                    </View>
                    <View style={styles.thinkingBody}>
                      <ThinkingSpinner size="lg" variant="assemble" color="#4de6a8" />
                    </View>
                  </View>
                )}
              </>
            )}
          </ScrollView>

          <Animated.View style={styles.composerContainer}>
            <View style={styles.composerRow}>
              {/* Add attachment button */}
              <Pressable
                onPress={handleOpenMediaPicker}
                style={styles.composerIconButton}
                accessibilityRole="button"
                accessibilityLabel="Add attachment"
                hitSlop={10}
              >
                <Plus width={18} height={18} color={colors.textSecondary} strokeWidth={2} />
              </Pressable>

              {/* History/Reset context button */}
              <Pressable
                onPress={handleResetContext}
                style={styles.composerIconButton}
                accessibilityRole="button"
                accessibilityLabel="Reset context"
                hitSlop={10}
              >
                <Clock width={18} height={18} color={colors.textSecondary} strokeWidth={1.5} />
              </Pressable>

              {/* Text input */}
              <View style={styles.composerInputContainer}>
                <TextInput
                  style={styles.composerInput}
                  value={messageText}
                  onChangeText={(value) => {
                    setMessageText(value);
                    if (messageError) {
                      setMessageError(null);
                    }
                  }}
                  placeholder={`Chat with ${selectedNode.label}`}
                  placeholderTextColor={colors.textMuted}
                  multiline
                  maxLength={4000}
                  textAlignVertical="center"
                />
              </View>

              {/* Send button */}
              <Pressable
                style={[
                  styles.composerSendButton,
                  canSend && styles.composerSendButtonActive,
                ]}
                onPress={handlePrimaryPress}
                onLongPress={handleQueueLongPress}
                delayLongPress={250}
                disabled={!canSend}
                accessibilityRole="button"
                accessibilityLabel={isRunning ? 'Interrupt message' : 'Send message'}
                accessibilityHint={isRunning ? 'Long press to queue instead' : undefined}
              >
                <ArrowUp
                  width={20}
                  height={20}
                  color={canSend ? colors.bgPrimary : colors.textMuted}
                  strokeWidth={2.5}
                />
              </Pressable>
            </View>

            {messageError && <Text style={styles.errorText}>{messageError}</Text>}
          </Animated.View>
          <Animated.View style={bottomSpacerStyle} pointerEvents="none" />
        </View>
      ) : (
        <ScrollView style={styles.detailsContainer}>
          <DetailRow label="ID" value={selectedNode.id.slice(0, 8)} mono />
          <DetailRow label="Status" value={selectedNode.status} />
          <DetailRow label="Provider" value={selectedNode.provider} />
          <DetailRow label="Role" value={selectedNode.roleTemplate} />
          <DetailRow label="Summary" value={selectedNode.summary || 'No activity'} />
          {selectedNode.inboxCount !== undefined && (
            <DetailRow label="Inbox" value={`${selectedNode.inboxCount} messages`} />
          )}
          <View style={styles.capabilitiesSection}>
            <Text style={styles.sectionTitle}>Capabilities</Text>
            <View style={styles.capabilities}>
              {selectedNode.capabilities?.edgeManagement && (
                <Badge
                  label={`Edges: ${selectedNode.capabilities.edgeManagement}`}
                />
              )}
              {selectedNode.capabilities?.writeCode && <Badge label="Code" />}
              {selectedNode.capabilities?.writeDocs && <Badge label="Docs" />}
              {selectedNode.capabilities?.runCommands && <Badge label="Commands" />}
              {selectedNode.capabilities?.delegateOnly && <Badge label="Delegate" />}
            </View>
          </View>
        </ScrollView>
      )}
    </Animated.View>

    <MediaPickerDrawer
      visible={mediaPickerVisible}
      onClose={handleCloseMediaPicker}
      onSelectCamera={handleSelectCamera}
      onSelectPhotos={handleSelectPhotos}
      onSelectFiles={handleSelectFiles}
    />
    </>
  );
}

type TimelineEvent = TimelineItem<ChatMessage, ToolEvent, TurnStatusEvent>;

function TimelineItem({
  item,
  onRetry,
}: {
  item: TimelineEvent;
  onRetry: (message: ChatMessage) => void;
}) {
  if (item.type === 'message') {
    return <MessageItem message={item.data} onRetry={onRetry} />;
  }
  if (item.type === 'status') {
    return <StatusItem event={item.data} />;
  }
  return <ToolItem event={item.data} />;
}

function MessageItem({
  message,
  onRetry,
}: {
  message: ChatMessage;
  onRetry: (message: ChatMessage) => void;
}) {
  const hasThinking = Boolean(message.thinking && message.thinking.length > 0);
  const isThinkingActive = message.thinkingStreaming || hasThinking;
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const thinkingExpanded = manualExpanded ?? Boolean(message.thinkingStreaming);
  const isPending = message.pending;
  const hasError = Boolean(message.sendError);

  return (
    <View
      style={[
        styles.messageCard,
        message.role === 'user' ? styles.messageUser : styles.messageAssistant,
        message.streaming && styles.messageStreaming,
        message.thinkingStreaming && styles.messageThinking,
        isPending && styles.messagePending,
        hasError && styles.messageError,
      ]}
    >
      <View style={styles.messageHeader}>
        <Text style={styles.messageRole}>{message.role}</Text>
        <View style={styles.messageMeta}>
          {isPending && (
            <View style={styles.metaItem}>
              <ThinkingSpinner size="sm" variant="assemble" color="#94a3b8" />
              <Text style={styles.metaText}>sending</Text>
            </View>
          )}
          {hasError && <Text style={styles.errorBadge}>Failed</Text>}
          {message.streaming && !message.thinkingStreaming && (
            <View style={styles.metaItem}>
              <ThinkingSpinner size="sm" variant="assemble" color="#60a5fa" />
              <Text style={styles.metaTextStreaming}>streaming</Text>
            </View>
          )}
          {message.thinkingStreaming && (
            <View style={styles.metaItem}>
              <ThinkingSpinner size="sm" variant="assemble" color="#4de6a8" />
              <Text style={styles.metaTextThinking}>thinking</Text>
            </View>
          )}
          {message.status === 'interrupted' && (
            <Text style={styles.interruptedText}>interrupted</Text>
          )}
          <Text style={styles.messageTime}>{formatClockTime(message.createdAt)}</Text>
        </View>
      </View>

      {isThinkingActive && (
        <View
          style={[
            styles.thinkingSection,
            message.thinkingStreaming && styles.thinkingSectionActive,
          ]}
        >
          <Pressable
            style={styles.thinkingToggle}
            onPress={() =>
              setManualExpanded(manualExpanded === null ? !thinkingExpanded : !manualExpanded)
            }
          >
            <Text style={styles.thinkingToggleIcon}>
              {thinkingExpanded ? 'v' : '>'}
            </Text>
            <Text style={styles.thinkingToggleLabel}>Thinking</Text>
            {message.thinkingStreaming && <View style={styles.thinkingDot} />}
          </Pressable>
          {thinkingExpanded && (
            <Text style={styles.thinkingContent} selectable>
              {message.thinking ?? ''}
            </Text>
          )}
        </View>
      )}

      {message.content.length > 0 && (
        <MarkdownMessage>{message.content}</MarkdownMessage>
      )}

      {hasError && (
        <View style={styles.retryRow}>
          <Pressable style={styles.retryButton} onPress={() => onRetry(message)}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
          {message.sendError && (
            <Text style={styles.retryErrorText} numberOfLines={2}>
              {message.sendError}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function StatusItem({ event }: { event: TurnStatusEvent }) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{formatTurnSummary(event.status, event.detail)}</Text>
      <Text style={styles.statusTime}>{formatClockTime(event.timestamp)}</Text>
    </View>
  );
}

function ToolItem({ event }: { event: ToolEvent }) {
  const [expanded, setExpanded] = useState(false);
  const isCompleted = event.status === 'completed' || event.status === 'failed';
  const hasError = event.status === 'failed' || Boolean(event.error);
  const argsText = JSON.stringify(event.tool.args, null, 2);
  const resultText = event.result ? JSON.stringify(event.result, null, 2) : null;
  const statusStyle =
    event.status === 'completed'
      ? styles.toolStatusCompleted
      : event.status === 'failed'
        ? styles.toolStatusFailed
        : event.status === 'started'
          ? styles.toolStatusStarted
          : styles.toolStatusProposed;

  return (
    <View style={[styles.toolCard, hasError && styles.toolCardError]}>
      <Pressable style={styles.toolHeader} onPress={() => setExpanded(!expanded)}>
        <View style={styles.toolTitleRow}>
          <Text style={styles.toolCaret}>{expanded ? 'v' : '>'}</Text>
          <Text style={styles.toolName} numberOfLines={1}>
            {event.tool.name}
          </Text>
          <Text style={[styles.toolStatus, statusStyle]}>
            {event.status}
          </Text>
        </View>
        <Text style={styles.toolTime}>{formatClockTime(event.timestamp)}</Text>
      </Pressable>

      {expanded && (
        <View style={styles.toolBody}>
          <Text style={styles.toolSectionLabel}>Arguments</Text>
          <Text style={[styles.toolCode, styles.mono]} selectable>
            {argsText}
          </Text>

          {hasError && event.error?.message && (
            <>
              <Text style={[styles.toolSectionLabel, styles.toolErrorLabel]}>Error</Text>
              <Text style={[styles.toolCode, styles.toolErrorText, styles.mono]} selectable>
                {event.error.message}
              </Text>
            </>
          )}

          {isCompleted && resultText && (
            <>
              <Text style={styles.toolSectionLabel}>Result</Text>
              <Text style={[styles.toolCode, styles.mono]} selectable>
                {resultText}
              </Text>
            </>
          )}
        </View>
      )}
    </View>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, mono && styles.mono]} selectable>
        {value}
      </Text>
    </View>
  );
}

function Badge({ label }: { label: string }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    backgroundColor: colors.bgSurface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    zIndex: 30,
  },
  handleContainer: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: colors.borderStrong,
    borderRadius: 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 16,
    fontFamily: fontFamily.semibold,
    flex: 1,
  },
  closeButton: {
    padding: 4,
  },
  closeText: {
    color: colors.textSecondary,
    fontSize: 24,
    lineHeight: 24,
  },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.accent,
  },
  tabText: {
    color: colors.textMuted,
    fontSize: 14,
    fontFamily: fontFamily.regular,
  },
  tabTextActive: {
    color: colors.accent,
    fontFamily: fontFamily.semibold,
  },
  chatContainer: {
    flex: 1,
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    padding: 12,
    gap: 12,
  },
  emptyText: {
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: 20,
  },
  messageCard: {
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: colors.bgHover,
  },
  messageUser: {
    alignSelf: 'flex-end',
    maxWidth: '88%',
    borderColor: colors.border,
  },
  messageAssistant: {
    alignSelf: 'stretch',
    backgroundColor: 'transparent',
    paddingRight: 0,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  messageStreaming: {
    borderLeftColor: colors.streamingBlue,
  },
  messageThinking: {
    borderLeftColor: colors.thinkingGreen,
  },
  messagePending: {
    opacity: 0.7,
  },
  messageError: {
    borderColor: colors.statusFailed,
  },
  messageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  messageRole: {
    color: colors.textSecondary,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontFamily: fontFamily.medium,
  },
  messageMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  messageText: {
    color: colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
  messageTime: {
    color: colors.textMuted,
    fontSize: 10,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    color: colors.textSecondary,
    fontSize: 10,
  },
  metaTextStreaming: {
    color: colors.streamingBlue,
    fontSize: 10,
  },
  metaTextThinking: {
    color: colors.thinkingGreen,
    fontSize: 10,
  },
  interruptedText: {
    color: colors.statusBlocked,
    fontSize: 10,
  },
  errorBadge: {
    color: colors.statusFailed,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    backgroundColor: 'rgba(184, 120, 125, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  thinkingSection: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 8,
  },
  thinkingSectionActive: {
    borderColor: colors.thinkingGreen,
    backgroundColor: 'rgba(77, 230, 168, 0.05)',
  },
  thinkingToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: colors.bgSecondary,
  },
  thinkingToggleIcon: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  thinkingToggleLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  thinkingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.thinkingGreen,
  },
  thinkingContent: {
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgElevated,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  retryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  retryButton: {
    borderWidth: 1,
    borderColor: colors.statusFailed,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  retryText: {
    color: colors.statusFailed,
    fontSize: 12,
  },
  retryErrorText: {
    color: colors.statusFailed,
    fontSize: 11,
    flex: 1,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  statusLabel: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  statusTime: {
    color: colors.textMuted,
    fontSize: 10,
  },
  toolCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.bgElevated,
    overflow: 'hidden',
  },
  toolCardError: {
    borderColor: colors.statusFailed,
  },
  toolHeader: {
    padding: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  toolTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  toolCaret: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  toolName: {
    color: colors.textPrimary,
    fontSize: 12,
    flexShrink: 1,
  },
  toolStatus: {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  toolStatusProposed: {
    color: colors.textSecondary,
  },
  toolStatusStarted: {
    color: colors.streamingBlue,
  },
  toolStatusCompleted: {
    color: colors.statusRunning,
  },
  toolStatusFailed: {
    color: colors.statusFailed,
  },
  toolTime: {
    color: colors.textMuted,
    fontSize: 10,
  },
  toolBody: {
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 8,
  },
  toolSectionLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  toolCode: {
    color: colors.textPrimary,
    fontSize: 11,
    lineHeight: 16,
  },
  toolErrorLabel: {
    color: colors.statusFailed,
  },
  toolErrorText: {
    color: colors.statusFailed,
  },
  thinkingPlaceholder: {
    borderLeftWidth: 2,
    borderLeftColor: colors.thinkingGreen,
    paddingLeft: 10,
    paddingVertical: 8,
  },
  thinkingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  thinkingRole: {
    color: colors.textSecondary,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  thinkingBody: {
    paddingVertical: 6,
  },
  composerContainer: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  composerIconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerInputContainer: {
    flex: 1,
    backgroundColor: colors.bgElevated,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 40,
    justifyContent: 'center',
  },
  composerInput: {
    color: colors.textPrimary,
    fontSize: 15,
    lineHeight: 20,
    paddingVertical: 0,
    paddingHorizontal: 0,
    margin: 0,
    minHeight: 20,
    maxHeight: 100,
  },
  composerSendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerSendButtonActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  errorText: {
    color: colors.statusFailed,
    fontSize: 12,
  },
  detailsContainer: {
    flex: 1,
    padding: 16,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  detailLabel: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  detailValue: {
    color: colors.textPrimary,
    fontSize: 14,
  },
  mono: {
    fontFamily: fontFamily.mono,
  },
  capabilitiesSection: {
    marginTop: 16,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  capabilities: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  badge: {
    backgroundColor: colors.bgHover,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  badgeText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
});
