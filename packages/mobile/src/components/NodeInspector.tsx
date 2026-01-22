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
  Clipboard,
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
  FadeIn,
  FadeOut,
  LinearTransition,
  type EasingFunction,
  type EasingFunctionFactory,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Clock, ArrowUp, MoreHoriz, Copy, Link as LinkIcon, Play, Pause } from 'iconoir-react-native';
import {
  useGraphStore,
  type TurnStatusEvent,
} from '@/stores/graph-store';
import type { Envelope, ChatMessage, ToolEvent, TodoItem } from '@vuhlp/contracts';
import { api } from '@/lib/api';
import { useChatAutoScroll } from '@/lib/useChatAutoScroll';
import { ThinkingSpinner } from '@vuhlp/spinners/native';
import { MarkdownMessage } from '@/components/MarkdownMessage';
import { MediaPickerDrawer } from '@/components/MediaPickerDrawer';
import { colors, getStatusColor, getProviderColors, fontFamily } from '@/lib/theme';
import { createLocalId } from '@/lib/ids';
import {
  buildTimeline,
  buildTimelineUpdateKey,
  formatClockTime,
  formatTurnSummary,
  type TimelineItem,
  isHandoffToolName,
  isHandoffToolEvent,
  buildReceiveHandoffToolEvent,
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
  const edges = useGraphStore((s) => s.edges);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const selectedEdgeId = useGraphStore((s) => s.selectedEdgeId);
  const inspectorOpen = useGraphStore((s) => s.inspectorOpen);
  const chatMessages = useGraphStore((s) => s.chatMessages);
  const toolEvents = useGraphStore((s) => s.toolEvents);
  const turnStatusEvents = useGraphStore((s) => s.turnStatusEvents);
  const recentHandoffs = useGraphStore((s) => s.recentHandoffs);
  const selectNode = useGraphStore((s) => s.selectNode);
  const selectEdge = useGraphStore((s) => s.selectEdge);
  const removeNode = useGraphStore((s) => s.removeNode);
  const removeEdge = useGraphStore((s) => s.removeEdge);
  const addChatMessage = useGraphStore((s) => s.addChatMessage);
  const updateChatMessageStatus = useGraphStore((s) => s.updateChatMessageStatus);
  const clearNodeMessages = useGraphStore((s) => s.clearNodeMessages);

  const [messageText, setMessageText] = useState('');
  const [messageError, setMessageError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'chat' | 'details'>('chat');
  const [todosExpanded, setTodosExpanded] = useState(true);
  const todosIconRotation = useSharedValue(1); // 1 = expanded (90deg), 0 = collapsed (0deg)
  const tabIndicatorPosition = useSharedValue(0); // 0 = chat, 1 = details
  const [tabContainerWidth, setTabContainerWidth] = useState(0);
  const [mediaPickerVisible, setMediaPickerVisible] = useState(false);
  const [processPending, setProcessPending] = useState<'start' | 'stop' | 'interrupt' | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);

  // Animated style for todos toggle icon rotation
  const todosIconAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${todosIconRotation.value * 90}deg` }],
  }));

  // Animated style for tab indicator sliding animation
  // Calculate indicator width (half the container minus padding on each side)
  const indicatorWidth = tabContainerWidth > 0 ? (tabContainerWidth - 6) / 2 : 0;
  const tabIndicatorAnimatedStyle = useAnimatedStyle(() => {
    // Animate translateX: 0 for chat, indicatorWidth for details
    const translateX = withSpring(tabIndicatorPosition.value * indicatorWidth, {
      damping: 100,
      stiffness: 700,
    });
    return {
      transform: [{ translateX }],
    };
  }, [indicatorWidth]);

  // Handle tab container layout to get width for animation
  const handleTabContainerLayout = useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
    setTabContainerWidth(event.nativeEvent.layout.width);
  }, []);

  // Handle tab change with animation
  const handleTabChange = useCallback((tab: 'chat' | 'details') => {
    tabIndicatorPosition.value = tab === 'chat' ? 0 : 1;
    setActiveTab(tab);
  }, [tabIndicatorPosition]);

  const handleTodosToggle = useCallback(() => {
    todosIconRotation.value = withSpring(todosExpanded ? 0 : 1, { damping: 100, stiffness: 700 });
    setTodosExpanded(!todosExpanded);
  }, [todosExpanded, todosIconRotation]);

  const todosSwipeGesture = Gesture.Pan()
    .onEnd((event) => {
      const threshold = 20;
      // Swipe up to expand, swipe down to collapse
      if (event.translationY < -threshold && !todosExpanded) {
        runOnJS(setTodosExpanded)(true);
        todosIconRotation.value = withSpring(1, { damping: 100, stiffness: 700 });
      } else if (event.translationY > threshold && todosExpanded) {
        runOnJS(setTodosExpanded)(false);
        todosIconRotation.value = withSpring(0, { damping: 100, stiffness: 700 });
      }
    });
  const scrollViewRef = useRef<ScrollView>(null);
  const sendLongPressRef = useRef(false);
  const keyboardConfigWarnedRef = useRef(false);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );
  const selectedEdge = useMemo(
    () => edges.find((edge) => edge.id === selectedEdgeId) ?? null,
    [edges, selectedEdgeId]
  );

  const [displayNode, setDisplayNode] = useState(selectedNode);
  const [displayEdge, setDisplayEdge] = useState(selectedEdge);

  // Preserve the resting safe-area inset so it doesn't collapse during keyboard transitions.
  useEffect(() => {
    setRestingInset((current) => (insets.bottom > current ? insets.bottom : current));
  }, [insets.bottom]);

  // Sync display node/edge with selection, but keep old ones while closing
  useEffect(() => {
    if (selectedNode) {
      setDisplayNode(selectedNode);
    }
  }, [selectedNode]);

  useEffect(() => {
    if (selectedEdge) {
      setDisplayEdge(selectedEdge);
    }
  }, [selectedEdge]);

  const activeEdge = selectedEdge ?? (!selectedNodeId ? displayEdge : null);
  const activeNode = activeEdge ? null : (selectedNode ?? displayNode);
  const isOrchestrator =
    activeNode?.roleTemplate.trim().toLowerCase() === 'orchestrator';
  const isAutoMode = run?.mode === 'AUTO';

  // Compute connected edges for the active node
  const connectedEdges = useMemo(() => {
    if (!activeNode?.id) return [];
    return edges.filter(
      (edge) => edge.from === activeNode.id || edge.to === activeNode.id
    );
  }, [edges, activeNode?.id]);

  const connectedNodes = useMemo(() => {
    if (!activeNode?.id) return [];
    const nodeIds = new Set<string>();
    connectedEdges.forEach((edge) => {
      if (edge.from === activeNode.id) nodeIds.add(edge.to);
      if (edge.to === activeNode.id) nodeIds.add(edge.from);
    });
    return nodes.filter((node) => nodeIds.has(node.id));
  }, [connectedEdges, nodes, activeNode?.id]);
  const nodeMessages = activeNode?.id ? chatMessages[activeNode.id] ?? [] : [];
  const nodeToolEvents = useMemo(() => {
    if (!activeNode?.id) return [];
    return toolEvents.filter((event) => event.nodeId === activeNode.id);
  }, [toolEvents, activeNode?.id]);
  const incomingHandoffs = useMemo(
    () => activeNode?.id ? recentHandoffs.filter((handoff) => handoff.toNodeId === activeNode.id) : [],
    [recentHandoffs, activeNode?.id]
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
    if (!activeNode?.id) return [];
    return turnStatusEvents.filter((event) => event.nodeId === activeNode.id);
  }, [turnStatusEvents, activeNode?.id]);
  const timeline = useMemo(
    () => buildTimeline(nodeMessages, combinedToolEvents, nodeStatusEvents),
    [nodeMessages, combinedToolEvents, nodeStatusEvents]
  );
  const isRunning = activeNode?.status === 'running';
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
  const { handleScroll, onContentSizeChange, scrollToBottom } = useChatAutoScroll({
    scrollRef: scrollViewRef,
    enabled: activeTab === 'chat' && Boolean(activeNode),
    updateKey: autoScrollKey,
    resetKey: activeNode?.id ?? '',
  });

  // Animation values
  const translateY = useSharedValue(maxTranslateY); // Start collapsed
  const context = useSharedValue({ y: 0 });
  const isClosingRef = useRef(false);
  const previousSelectionKey = useRef<string | null>(null);
  const previousInspectorOpen = useRef(inspectorOpen);

  const activeSelectionKey = activeEdge
    ? `edge:${activeEdge.id}`
    : activeNode
      ? `node:${activeNode.id}`
      : null;

  const finalizeClose = useCallback(() => {
    isClosingRef.current = false;
    // Clear display node only after animation finishes
    if (!inspectorOpen) {
      setDisplayNode(null);
      setDisplayEdge(null);
    }
  }, [inspectorOpen]);

  // Reset to collapsed state when node changes or opens.
  useEffect(() => {
    const wasOpen = previousInspectorOpen.current;
    const selectionChanged = previousSelectionKey.current !== activeSelectionKey;
    previousInspectorOpen.current = inspectorOpen;
    previousSelectionKey.current = activeSelectionKey;

    if (!activeSelectionKey) {
      return;
    }

    if (inspectorOpen && (selectionChanged || !wasOpen)) {
      isClosingRef.current = false;
      // Start from closed position and animate in
      translateY.value = closedTranslateY;
      translateY.value = withSpring(maxTranslateY, { damping: 50, stiffness: 200 });
    }
  }, [inspectorOpen, activeSelectionKey, maxTranslateY, closedTranslateY]);

  useEffect(() => {
    // If not open and no closing animation pending, do nothing
    // If it *was* open and now isn't, animate close
    if (inspectorOpen || isClosingRef.current || (!displayNode && !displayEdge)) {
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
  }, [closedTranslateY, finalizeClose, inspectorOpen, displayNode, displayEdge]);

  useEffect(() => {
    setMessageText('');
    setMessageError(null);
  }, [activeNode?.id]);

  useEffect(() => {
    if (selectedEdgeId) {
      setActiveTab('details');
      tabIndicatorPosition.value = 1;
    }
  }, [selectedEdgeId, tabIndicatorPosition]);

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
    if (selectedEdgeId) {
      selectEdge(null);
    } else {
      selectNode(null);
    }
  }, [inspectorOpen, selectedEdgeId, selectEdge, selectNode]);

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
      if (!run || !activeNode) {
        const errorText = 'Start a run to send messages.';
        console.warn('[inspector] cannot send message without active run');
        setMessageError(errorText);
        if (activeNode) {
          updateChatMessageStatus(activeNode.id, messageId, {
            pending: false,
            sendError: errorText,
          });
        }
        return;
      }

      try {
        await api.sendMessage(run.id, activeNode.id, content, interrupt);
        updateChatMessageStatus(activeNode.id, messageId, { pending: false });
      } catch (err) {
        const errorText =
          err instanceof Error ? err.message : 'Failed to send message.';
        console.error('[inspector] failed to send message:', err);
        updateChatMessageStatus(activeNode.id, messageId, {
          pending: false,
          sendError: errorText,
        });
      }
    },
    [run, activeNode, updateChatMessageStatus]
  );

  const handleResetContext = useCallback(() => {
    if (!activeNode?.id) return;
    clearNodeMessages(activeNode.id);
    setMessageText('');
    setMessageError(null);
    if (!run) {
      const errorText = 'Start a run to reset context.';
      console.warn('[inspector] cannot reset context without active run');
      setMessageError(errorText);
      return;
    }
    api.resetNode(run.id, activeNode.id).catch((err) => {
      console.error('[inspector] failed to reset context:', err);
      setMessageError('Failed to reset context.');
    });
  }, [clearNodeMessages, run, activeNode]);

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
      if (!content || !activeNode?.id) return;

      const resetCommands = activeNode?.session?.resetCommands ?? ['/new', '/clear'];
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
        nodeId: activeNode.id,
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
      scrollToBottom();
    },
    [messageText, activeNode, run, addChatMessage, sendMessage, handleResetContext, scrollToBottom]
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
      if (!activeNode?.id) return;
      updateChatMessageStatus(activeNode.id, message.id, {
        pending: true,
        sendError: undefined,
      });
      setMessageError(null);
      void sendMessage(message.id, message.content, message.interrupt ?? true);
    },
    [activeNode, updateChatMessageStatus, sendMessage]
  );

  const headerDotColor = activeEdge
    ? colors.accent
    : getStatusColor(activeNode?.status ?? 'idle');

  const edgeSourceLabel = activeEdge
    ? nodes.find((node) => node.id === activeEdge.from)?.label ?? activeEdge.from
    : '';
  const edgeTargetLabel = activeEdge
    ? nodes.find((node) => node.id === activeEdge.to)?.label ?? activeEdge.to
    : '';

  const handleDeleteNode = useCallback(() => {
    if (!activeNode) {
      return;
    }
    if (!run) {
      console.warn('[inspector] cannot delete node without active run', { nodeId: activeNode.id });
      Alert.alert('Delete node unavailable', 'Start a run to delete nodes.', [{ text: 'OK' }]);
      return;
    }
    Alert.alert(
      `Delete node "${activeNode.label}"?`,
      'This will also remove any connected edges. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            api
              .deleteNode(run.id, activeNode.id)
              .then(() => removeNode(activeNode.id))
              .catch((error) => {
                console.error('[inspector] failed to delete node', error);
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                Alert.alert('Delete failed', `Could not delete node: ${errorMessage}`, [{ text: 'OK' }]);
              });
          },
        },
      ]
    );
  }, [activeNode, removeNode, run]);

  const handleCopyId = useCallback(() => {
    const id = activeEdge?.id ?? activeNode?.id;
    if (id) {
      Clipboard.setString(id);
    }
  }, [activeEdge?.id, activeNode?.id]);

  const handleDeleteEdge = useCallback(() => {
    if (!activeEdge) {
      return;
    }
    if (!run) {
      console.warn('[inspector] cannot delete edge without active run', { edgeId: activeEdge.id });
      return;
    }
    console.log('[inspector] deleting edge', { edgeId: activeEdge.id });
    api
      .deleteEdge(run.id, activeEdge.id)
      .then(() => {
        console.log('[inspector] edge deleted successfully', { edgeId: activeEdge.id });
        removeEdge(activeEdge.id);
      })
      .catch((error) => {
        console.error('[inspector] failed to delete edge', error);
      });
  }, [activeEdge, removeEdge, run]);

  // Process control handlers
  const handleStartProcess = useCallback(() => {
    if (!run || !activeNode) {
      setProcessError('Start a run to manage the process.');
      console.warn('[inspector] cannot start process: no run or node');
      return;
    }
    setProcessPending('start');
    setProcessError(null);
    console.log('[inspector] starting process', { nodeId: activeNode.id });
    api.startNodeProcess(run.id, activeNode.id)
      .then(() => {
        console.log('[inspector] process started successfully');
      })
      .catch((error) => {
        console.error('[inspector] failed to start process', error);
        setProcessError(error instanceof Error ? error.message : 'Failed to start process.');
      })
      .finally(() => setProcessPending(null));
  }, [run, activeNode]);

  const handleStopProcess = useCallback(() => {
    if (!run || !activeNode) {
      setProcessError('Start a run to manage the process.');
      console.warn('[inspector] cannot stop process: no run or node');
      return;
    }
    setProcessPending('stop');
    setProcessError(null);
    console.log('[inspector] stopping process', { nodeId: activeNode.id });
    api.stopNodeProcess(run.id, activeNode.id)
      .then(() => {
        console.log('[inspector] process stopped successfully');
      })
      .catch((error) => {
        console.error('[inspector] failed to stop process', error);
        setProcessError(error instanceof Error ? error.message : 'Failed to stop process.');
      })
      .finally(() => setProcessPending(null));
  }, [run, activeNode]);

  const handleInterruptProcess = useCallback(() => {
    if (!run || !activeNode) {
      setProcessError('Start a run to manage the process.');
      console.warn('[inspector] cannot interrupt process: no run or node');
      return;
    }
    setProcessPending('interrupt');
    setProcessError(null);
    console.log('[inspector] interrupting process', { nodeId: activeNode.id });
    api.interruptNodeProcess(run.id, activeNode.id)
      .then(() => {
        console.log('[inspector] process interrupted successfully');
      })
      .catch((error) => {
        console.error('[inspector] failed to interrupt process', error);
        setProcessError(error instanceof Error ? error.message : 'Failed to interrupt process.');
      })
      .finally(() => setProcessPending(null));
  }, [run, activeNode]);

  const handleShowOverflowMenu = useCallback(() => {
    const isEdge = Boolean(activeEdge);
    const options = isEdge
      ? ['Copy ID', 'Delete Edge', 'Cancel']
      : ['Copy ID', 'Delete Node', 'Cancel'];
    const destructiveIndex = 1;
    const cancelIndex = 2;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          destructiveButtonIndex: destructiveIndex,
          cancelButtonIndex: cancelIndex,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) {
            handleCopyId();
          } else if (buttonIndex === 1) {
            if (isEdge) {
              handleDeleteEdge();
            } else {
              handleDeleteNode();
            }
          }
        }
      );
    } else {
      Alert.alert('Options', undefined, [
        { text: 'Copy ID', onPress: handleCopyId },
        {
          text: isEdge ? 'Delete Edge' : 'Delete Node',
          style: 'destructive',
          onPress: isEdge ? handleDeleteEdge : handleDeleteNode,
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [activeEdge, handleCopyId, handleDeleteEdge, handleDeleteNode]);

  if (!activeNode && !activeEdge) {
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
                  { backgroundColor: headerDotColor },
                ]}
              />
              <Text style={styles.title} numberOfLines={1}>
                {activeEdge
                  ? activeEdge.label || 'Edge'
                  : activeNode?.label ?? 'Node'}
              </Text>
            </View>
            <View style={styles.headerRight}>
              <Pressable
                onPress={handleShowOverflowMenu}
                style={styles.headerIconButton}
                hitSlop={12}
              >
                <MoreHoriz width={22} height={22} color={colors.textSecondary} strokeWidth={2} />
              </Pressable>
              <Pressable
                onPress={handleClose}
                style={styles.headerIconButton}
                hitSlop={12}
              >
                <Text style={styles.closeText}>×</Text>
              </Pressable>
            </View>
          </View>

          {/* Segmented Tabs */}
          {!activeEdge && (
            <View style={styles.tabsContainer}>
              <View style={styles.tabsSegmented} onLayout={handleTabContainerLayout}>
                {/* Animated sliding indicator */}
                <Animated.View
                  style={[
                    styles.tabIndicator,
                    { width: indicatorWidth > 0 ? indicatorWidth : '50%' },
                    tabIndicatorAnimatedStyle,
                  ]}
                />
                <Pressable
                  style={styles.tabSegment}
                  onPress={() => handleTabChange('chat')}
                >
                  <Text style={[styles.tabSegmentText, activeTab === 'chat' && styles.tabSegmentTextActive]}>
                    Chat
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.tabSegment}
                  onPress={() => handleTabChange('details')}
                >
                  <Text style={[styles.tabSegmentText, activeTab === 'details' && styles.tabSegmentTextActive]}>
                    Details
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
        </Animated.View>
      </GestureDetector>

      {/* Content - outside gesture detector for text selection */}
      {activeEdge ? (
        <ScrollView style={styles.detailsContainer} contentContainerStyle={styles.detailsContent}>
          {/* Edge Info Card */}
          <InfoCard>
            <View style={styles.detailsStatusRow}>
              <View style={styles.edgeTypeBadge}>
                <Text style={styles.edgeTypeBadgeText}>{activeEdge.type}</Text>
              </View>
              <View style={[styles.edgeTypeBadge, styles.edgeDirectionBadge]}>
                <Text style={styles.edgeTypeBadgeText}>
                  {activeEdge.bidirectional ? '↔ Bidirectional' : '→ Directed'}
                </Text>
              </View>
            </View>
            <Pressable style={styles.idRow} onPress={handleCopyId}>
              <Text style={styles.idLabel}>ID</Text>
              <Text style={styles.idValue}>{activeEdge.id.slice(0, 8)}</Text>
              <Copy width={14} height={14} color={colors.textMuted} strokeWidth={2} />
            </Pressable>
          </InfoCard>

          {/* Connection Card */}
          <InfoCard>
            <Text style={styles.sectionLabel}>Connection</Text>
            <View style={styles.edgeConnectionRow}>
              <Pressable
                style={styles.edgeNodeChip}
                onPress={() => {
                  const fromNode = nodes.find((n) => n.id === activeEdge.from);
                  if (fromNode) selectNode(fromNode.id);
                }}
              >
                <View
                  style={[
                    styles.connectedNodeDot,
                    { backgroundColor: getStatusColor(nodes.find((n) => n.id === activeEdge.from)?.status ?? 'idle') },
                  ]}
                />
                <Text style={styles.edgeNodeLabel}>{edgeSourceLabel}</Text>
              </Pressable>
              <Text style={styles.edgeArrow}>{activeEdge.bidirectional ? '↔' : '→'}</Text>
              <Pressable
                style={styles.edgeNodeChip}
                onPress={() => {
                  const toNode = nodes.find((n) => n.id === activeEdge.to);
                  if (toNode) selectNode(toNode.id);
                }}
              >
                <View
                  style={[
                    styles.connectedNodeDot,
                    { backgroundColor: getStatusColor(nodes.find((n) => n.id === activeEdge.to)?.status ?? 'idle') },
                  ]}
                />
                <Text style={styles.edgeNodeLabel}>{edgeTargetLabel}</Text>
              </Pressable>
            </View>
          </InfoCard>

          {/* Label Card (if exists) */}
          {activeEdge.label && (
            <InfoCard>
              <Text style={styles.sectionLabel}>Label</Text>
              <Text style={styles.summaryText}>{activeEdge.label}</Text>
            </InfoCard>
          )}
        </ScrollView>
      ) : activeTab === 'chat' ? (
        <View style={styles.chatContainer}>
          <ScrollView
            ref={scrollViewRef}
            style={styles.messagesContainer}
            contentContainerStyle={styles.messagesContent}
            onScroll={handleScroll}
            onContentSizeChange={onContentSizeChange}
            scrollEventThrottle={16}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
          >
            {timeline.length === 0 && activeNode?.status !== 'running' ? (
              <Text style={styles.emptyText}>
                Start a conversation with {activeNode?.label ?? 'this node'}
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

          {/* Collapsible Todos Panel */}
          {activeNode?.todos && activeNode.todos.length > 0 && (
            <Animated.View style={styles.todosPanel} layout={LinearTransition.springify().damping(100).stiffness(700)}>
              <GestureDetector gesture={todosSwipeGesture}>
                <Pressable
                  style={styles.todosPanelToggle}
                  onPress={handleTodosToggle}
                >
                  <Animated.Text style={[styles.todosPanelToggleIcon, todosIconAnimatedStyle]}>
                    ▶
                  </Animated.Text>
                  <Text style={styles.todosPanelToggleLabel}>
                    Todos ({activeNode.todos.length})
                  </Text>
                  <View style={styles.todosPanelBadges}>
                    {activeNode.todos.filter(t => t.status === 'in_progress').length > 0 && (
                      <View style={styles.todosBadgeInProgress}>
                        <Text style={styles.todosBadgeText}>
                          {activeNode.todos.filter(t => t.status === 'in_progress').length} active
                        </Text>
                      </View>
                    )}
                    {activeNode.todos.filter(t => t.status === 'completed').length > 0 && (
                      <View style={styles.todosBadgeCompleted}>
                        <Text style={styles.todosBadgeTextCompleted}>
                          {activeNode.todos.filter(t => t.status === 'completed').length} done
                        </Text>
                      </View>
                    )}
                  </View>
                </Pressable>
              </GestureDetector>
              {todosExpanded && (
                <Animated.View
                  style={styles.todosPanelList}
                  entering={FadeIn.duration(80)}
                  exiting={FadeOut.duration(60)}
                >
                  {activeNode.todos.map((todo, index) => (
                    <Animated.View
                      key={`${todo.content}-${index}`}
                      style={[
                        styles.todoItem,
                        todo.status === 'pending' && styles.todoItemPending,
                        todo.status === 'in_progress' && styles.todoItemInProgress,
                        todo.status === 'completed' && styles.todoItemCompleted,
                      ]}
                      entering={FadeIn.delay(index * 10).springify().damping(100).stiffness(700)}
                      layout={LinearTransition.springify().damping(100).stiffness(700)}
                    >
                      <Text
                        style={[
                          styles.todoStatus,
                          todo.status === 'pending' && styles.todoStatusPending,
                          todo.status === 'in_progress' && styles.todoStatusInProgress,
                          todo.status === 'completed' && styles.todoStatusCompleted,
                        ]}
                      >
                        {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '▶' : '○'}
                      </Text>
                      <Text
                        style={[
                          styles.todoContent,
                          todo.status === 'completed' && styles.todoContentCompleted,
                        ]}
                      >
                        {todo.status === 'in_progress' ? todo.activeForm : todo.content}
                      </Text>
                    </Animated.View>
                  ))}
                </Animated.View>
              )}
            </Animated.View>
          )}

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
                  placeholder={`Chat with ${activeNode?.label ?? 'node'}`}
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
        <ScrollView style={styles.detailsContainer} contentContainerStyle={styles.detailsContent}>
          {activeNode && (
            <>
              {/* Status & Identity Card */}
              <InfoCard>
                <View style={styles.detailsStatusRow}>
                  <StatusBadge status={activeNode.status} />
                  <ProviderBadge provider={activeNode.provider} />
                </View>
                <View style={styles.identityRow}>
                  <Text style={styles.roleLabel}>{activeNode.roleTemplate}</Text>
                  {isOrchestrator && (
                    <View style={styles.orchestratorBadge}>
                      <Text style={styles.orchestratorBadgeText}>Orchestrator</Text>
                    </View>
                  )}
                  {isAutoMode && (
                    <View style={styles.autoLoopBadge}>
                      <Text style={styles.autoLoopBadgeText}>Auto</Text>
                    </View>
                  )}
                </View>
                <Pressable style={styles.idRow} onPress={handleCopyId}>
                  <Text style={styles.idLabel}>ID</Text>
                  <Text style={styles.idValue}>{activeNode.id.slice(0, 8)}</Text>
                  <Copy width={14} height={14} color={colors.textMuted} strokeWidth={2} />
                </Pressable>
              </InfoCard>

              {/* Process Controls Card */}
              <InfoCard>
                <Text style={styles.sectionLabel}>Process Controls</Text>
                <View style={styles.processControlsRow}>
                  {/* Start button */}
                  <Pressable
                    style={[
                      styles.processButton,
                      styles.processButtonStart,
                      (isRunning || processPending === 'start') && styles.processButtonDisabled,
                    ]}
                    onPress={handleStartProcess}
                    disabled={isRunning || processPending !== null}
                  >
                    <Play width={16} height={16} color={isRunning ? colors.textMuted : colors.bgPrimary} strokeWidth={2} />
                    <Text style={[styles.processButtonText, isRunning && styles.processButtonTextDisabled]}>
                      {processPending === 'start' ? 'Starting...' : 'Start'}
                    </Text>
                  </Pressable>

                  {/* Pause/Interrupt button */}
                  <Pressable
                    style={[
                      styles.processButton,
                      styles.processButtonPause,
                      (!isRunning || processPending === 'interrupt') && styles.processButtonDisabled,
                    ]}
                    onPress={handleInterruptProcess}
                    disabled={!isRunning || processPending !== null}
                  >
                    <Pause width={16} height={16} color={!isRunning ? colors.textMuted : colors.bgPrimary} strokeWidth={2} />
                    <Text style={[styles.processButtonText, !isRunning && styles.processButtonTextDisabled]}>
                      {processPending === 'interrupt' ? 'Pausing...' : 'Pause'}
                    </Text>
                  </Pressable>

                  {/* Stop button */}
                  <Pressable
                    style={[
                      styles.processButton,
                      styles.processButtonStop,
                      (activeNode.status === 'idle' || processPending === 'stop') && styles.processButtonDisabled,
                    ]}
                    onPress={handleStopProcess}
                    disabled={activeNode.status === 'idle' || processPending !== null}
                  >
                    <View style={[styles.stopIconSmall, activeNode.status === 'idle' && styles.stopIconDisabled]} />
                    <Text style={[styles.processButtonText, activeNode.status === 'idle' && styles.processButtonTextDisabled]}>
                      {processPending === 'stop' ? 'Stopping...' : 'Stop'}
                    </Text>
                  </Pressable>
                </View>
                {processError && <Text style={styles.processErrorText}>{processError}</Text>}
              </InfoCard>

              {/* Summary Card */}
              {activeNode.summary && (
                <InfoCard>
                  <Text style={styles.summaryLabel}>Summary</Text>
                  <Text style={styles.summaryText}>{activeNode.summary}</Text>
                </InfoCard>
              )}

              {/* Inbox Card */}
              {activeNode.inboxCount !== undefined && activeNode.inboxCount > 0 && (
                <InfoCard>
                  <View style={styles.inboxRow}>
                    <Text style={styles.inboxLabel}>Inbox</Text>
                    <View style={styles.inboxBadge}>
                      <Text style={styles.inboxBadgeText}>{activeNode.inboxCount}</Text>
                    </View>
                  </View>
                </InfoCard>
              )}

              {/* Connected Nodes Card */}
              {connectedNodes.length > 0 && (
                <InfoCard>
                  <Text style={styles.sectionLabel}>Connected Nodes</Text>
                  <View style={styles.connectedNodesGrid}>
                    {connectedNodes.map((node) => (
                      <Pressable
                        key={node.id}
                        style={styles.connectedNodeChip}
                        onPress={() => selectNode(node.id)}
                      >
                        <View
                          style={[
                            styles.connectedNodeDot,
                            { backgroundColor: getStatusColor(node.status) },
                          ]}
                        />
                        <Text style={styles.connectedNodeLabel} numberOfLines={1}>
                          {node.label}
                        </Text>
                        <LinkIcon width={12} height={12} color={colors.textMuted} strokeWidth={2} />
                      </Pressable>
                    ))}
                  </View>
                </InfoCard>
              )}

              {/* Capabilities Card */}
              <InfoCard>
                <Text style={styles.sectionLabel}>Capabilities</Text>
                <View style={styles.capabilitiesGrid}>
                  {activeNode.capabilities?.edgeManagement && (
                    <CapabilityBadge label={`Edges: ${activeNode.capabilities.edgeManagement}`} />
                  )}
                  {activeNode.capabilities?.writeCode && <CapabilityBadge label="Code" active />}
                  {activeNode.capabilities?.writeDocs && <CapabilityBadge label="Docs" active />}
                  {activeNode.capabilities?.runCommands && <CapabilityBadge label="Commands" active />}
                  {activeNode.capabilities?.delegateOnly && <CapabilityBadge label="Delegate" />}
                  {!activeNode.capabilities?.edgeManagement &&
                    !activeNode.capabilities?.writeCode &&
                    !activeNode.capabilities?.writeDocs &&
                    !activeNode.capabilities?.runCommands &&
                    !activeNode.capabilities?.delegateOnly && (
                      <Text style={styles.noCapabilities}>No special capabilities</Text>
                    )}
                </View>
              </InfoCard>
            </>
          )}
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

function InfoCard({ children }: { children: React.ReactNode }) {
  return <View style={styles.infoCard}>{children}</View>;
}

function StatusBadge({ status }: { status: string }) {
  const color = getStatusColor(status);
  return (
    <View style={[styles.statusBadge, { backgroundColor: `${color}20`, borderColor: `${color}50` }]}>
      <View style={[styles.statusBadgeDot, { backgroundColor: color }]} />
      <Text style={[styles.statusBadgeText, { color }]}>{status}</Text>
    </View>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  const providerColors = getProviderColors(provider);
  return (
    <View
      style={[
        styles.providerBadge,
        { backgroundColor: providerColors.bg, borderColor: providerColors.border },
      ]}
    >
      <Text style={[styles.providerBadgeText, { color: providerColors.text }]}>{provider}</Text>
    </View>
  );
}

function CapabilityBadge({ label, active }: { label: string; active?: boolean }) {
  return (
    <View style={[styles.capabilityBadge, active && styles.capabilityBadgeActive]}>
      <Text style={[styles.capabilityBadgeText, active && styles.capabilityBadgeTextActive]}>
        {label}
      </Text>
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
  closeText: {
    color: colors.textSecondary,
    fontSize: 28,
    lineHeight: 28,
    fontWeight: '300',
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
  roleBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
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
    paddingRight: 16,
  },
  detailValue: {
    color: colors.textPrimary,
    fontSize: 14,
    flex: 1,
    textAlign: 'right',
  },
  mono: {
    fontFamily: fontFamily.mono,
  },
  capabilitiesSection: {
    marginTop: 16,
  },
  actionSection: {
    marginTop: 16,
  },
  dangerButton: {
    backgroundColor: colors.bgHover,
    borderWidth: 1,
    borderColor: colors.statusFailed,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  dangerButtonText: {
    color: colors.statusFailed,
    fontSize: 13,
    fontFamily: fontFamily.semibold,
    textTransform: 'uppercase',
    letterSpacing: 1,
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
  tabCount: {
    color: colors.textMuted,
    fontSize: 12,
  },
  todosPanel: {
    backgroundColor: colors.bgElevated,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  todosPanelToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    backgroundColor: colors.bgSurface,
  },
  todosPanelToggleIcon: {
    color: colors.textMuted,
    fontSize: 10,
    width: 14,
  },
  todosPanelToggleLabel: {
    color: colors.textPrimary,
    fontSize: 12,
    fontFamily: fontFamily.semibold,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  todosPanelBadges: {
    flexDirection: 'row',
    gap: 6,
    marginLeft: 'auto',
  },
  todosBadgeInProgress: {
    backgroundColor: 'rgba(77, 230, 168, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  todosBadgeCompleted: {
    backgroundColor: 'rgba(0, 255, 136, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  todosBadgeText: {
    color: colors.accent,
    fontSize: 10,
    fontFamily: fontFamily.medium,
  },
  todosBadgeTextCompleted: {
    color: colors.statusRunning,
    fontSize: 10,
    fontFamily: fontFamily.medium,
  },
  todosPanelList: {
    padding: 10,
    gap: 8,
  },
  todoItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    backgroundColor: colors.bgElevated,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
  },
  todoItemPending: {
    borderLeftColor: colors.textMuted,
  },
  todoItemInProgress: {
    borderLeftColor: colors.accent,
    backgroundColor: 'rgba(77, 230, 168, 0.08)',
  },
  todoItemCompleted: {
    borderLeftColor: colors.statusRunning,
    opacity: 0.7,
  },
  todoStatus: {
    width: 18,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  todoStatusPending: {
    color: colors.textMuted,
  },
  todoStatusInProgress: {
    color: colors.accent,
  },
  todoStatusCompleted: {
    color: colors.statusRunning,
  },
  todoContent: {
    flex: 1,
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  todoContentCompleted: {
    textDecorationLine: 'line-through',
    color: colors.textMuted,
  },
  // Header improvements
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerIconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgHover,
  },
  // Segmented tabs
  tabsContainer: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  tabsSegmented: {
    flexDirection: 'row',
    backgroundColor: colors.bgElevated,
    borderRadius: 10,
    padding: 3,
    borderWidth: 1,
    borderColor: colors.border,
    position: 'relative',
  },
  tabIndicator: {
    position: 'absolute',
    top: 3,
    bottom: 3,
    left: 3,
    backgroundColor: colors.bgSurface,
    borderRadius: 8,
  },
  tabSegment: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
    zIndex: 1,
  },
  tabSegmentText: {
    color: colors.textMuted,
    fontSize: 13,
    fontFamily: fontFamily.medium,
  },
  tabSegmentTextActive: {
    color: colors.textPrimary,
    fontFamily: fontFamily.semibold,
  },
  // Details content
  detailsContent: {
    padding: 12,
    gap: 12,
  },
  // InfoCard
  infoCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 10,
  },
  // Status badge
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  statusBadgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusBadgeText: {
    fontSize: 12,
    fontFamily: fontFamily.semibold,
    textTransform: 'capitalize',
  },
  // Provider badge
  providerBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  providerBadgeText: {
    fontSize: 12,
    fontFamily: fontFamily.medium,
    textTransform: 'capitalize',
  },
  // Status row in details
  detailsStatusRow: {
    flexDirection: 'row',
    gap: 8,
  },
  // Identity row
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  roleLabel: {
    color: colors.textPrimary,
    fontSize: 15,
    fontFamily: fontFamily.semibold,
    textTransform: 'capitalize',
  },
  orchestratorBadge: {
    backgroundColor: colors.accentSubtle,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  orchestratorBadgeText: {
    color: colors.accent,
    fontSize: 10,
    fontFamily: fontFamily.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  autoLoopBadge: {
    backgroundColor: 'rgba(196, 166, 122, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  autoLoopBadgeText: {
    color: colors.statusBlocked,
    fontSize: 10,
    fontFamily: fontFamily.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  // ID row
  idRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  idLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: fontFamily.medium,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  idValue: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: fontFamily.mono,
    flex: 1,
  },
  // Summary
  summaryLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: fontFamily.medium,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  summaryText: {
    color: colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
  // Inbox
  inboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  inboxLabel: {
    color: colors.textSecondary,
    fontSize: 13,
    fontFamily: fontFamily.medium,
  },
  inboxBadge: {
    backgroundColor: colors.accentSubtle,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  inboxBadgeText: {
    color: colors.accent,
    fontSize: 13,
    fontFamily: fontFamily.semibold,
  },
  // Section label
  sectionLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: fontFamily.medium,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  // Connected nodes
  connectedNodesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  connectedNodeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.bgHover,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  connectedNodeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  connectedNodeLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: fontFamily.medium,
    maxWidth: 100,
  },
  // Capabilities
  capabilitiesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  capabilityBadge: {
    backgroundColor: colors.bgHover,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  capabilityBadgeActive: {
    backgroundColor: colors.accentSubtle,
    borderColor: colors.accentDim,
  },
  capabilityBadgeText: {
    color: colors.textMuted,
    fontSize: 12,
    fontFamily: fontFamily.medium,
  },
  capabilityBadgeTextActive: {
    color: colors.accent,
  },
  noCapabilities: {
    color: colors.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
  },
  // Process controls
  processControlsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  processButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  processButtonStart: {
    backgroundColor: colors.statusRunning,
    borderColor: colors.statusRunning,
  },
  processButtonPause: {
    backgroundColor: colors.statusBlocked,
    borderColor: colors.statusBlocked,
  },
  processButtonStop: {
    backgroundColor: colors.bgElevated,
    borderColor: colors.statusFailed,
  },
  processButtonDisabled: {
    opacity: 0.4,
  },
  processButtonText: {
    color: colors.bgPrimary,
    fontSize: 12,
    fontFamily: fontFamily.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  processButtonTextDisabled: {
    color: colors.textMuted,
  },
  stopIconSmall: {
    width: 10,
    height: 10,
    borderRadius: 2,
    backgroundColor: colors.statusFailed,
  },
  stopIconDisabled: {
    backgroundColor: colors.textMuted,
  },
  processErrorText: {
    color: colors.statusFailed,
    fontSize: 12,
    marginTop: 8,
  },
  // Edge styles
  edgeTypeBadge: {
    backgroundColor: colors.bgHover,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  edgeDirectionBadge: {
    backgroundColor: colors.accentSubtle,
    borderColor: colors.accentDim,
  },
  edgeTypeBadgeText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: fontFamily.medium,
  },
  edgeConnectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  edgeNodeChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.bgHover,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  edgeNodeLabel: {
    color: colors.textPrimary,
    fontSize: 13,
    fontFamily: fontFamily.medium,
    flex: 1,
  },
  edgeArrow: {
    color: colors.textMuted,
    fontSize: 16,
  },
});
