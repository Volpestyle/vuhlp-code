import { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
  useAnimatedKeyboard,
} from 'react-native-reanimated';
import {
  useGraphStore,
  type ChatMessage,
  type ToolEvent,
  type TurnStatusEvent,
} from '@/stores/graph-store';
import { api } from '@/lib/api';
import { useChatAutoScroll } from '@/lib/useChatAutoScroll';
import { ThinkingSpinner } from '@/components/ThinkingSpinner';
import { MarkdownMessage } from '@/components/MarkdownMessage';

const MIN_HEIGHT = 120;
const SNAP_THRESHOLD = 50;

interface NodeInspectorProps {
  bottomOverlayHeight?: number;
}

export function NodeInspector({ bottomOverlayHeight = 0 }: NodeInspectorProps) {
  const { height: screenHeight } = useWindowDimensions();
  const maxHeight = screenHeight * 0.7;
  const keyboard = useAnimatedKeyboard();

  // Calculate offsets
  // Expanded: offset 0 (visible height = maxHeight)
  // Collapsed: offset = maxHeight - MIN_HEIGHT
  const minTranslateY = 0;
  const maxTranslateY = maxHeight - MIN_HEIGHT;

  const run = useGraphStore((s) => s.run);
  const nodes = useGraphStore((s) => s.nodes);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const inspectorOpen = useGraphStore((s) => s.inspectorOpen);
  const chatMessages = useGraphStore((s) => s.chatMessages);
  const toolEvents = useGraphStore((s) => s.toolEvents);
  const turnStatusEvents = useGraphStore((s) => s.turnStatusEvents);
  const setInspectorOpen = useGraphStore((s) => s.setInspectorOpen);
  const addChatMessage = useGraphStore((s) => s.addChatMessage);
  const updateChatMessageStatus = useGraphStore((s) => s.updateChatMessageStatus);
  const clearNodeMessages = useGraphStore((s) => s.clearNodeMessages);

  const [messageText, setMessageText] = useState('');
  const [messageError, setMessageError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'chat' | 'details'>('chat');
  const scrollViewRef = useRef<ScrollView>(null);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const nodeMessages = selectedNodeId ? chatMessages[selectedNodeId] ?? [] : [];
  const nodeToolEvents = useMemo(() => {
    if (!selectedNodeId) return [];
    return toolEvents.filter((event) => event.nodeId === selectedNodeId);
  }, [toolEvents, selectedNodeId]);
  const nodeStatusEvents = useMemo(() => {
    if (!selectedNodeId) return [];
    return turnStatusEvents.filter((event) => event.nodeId === selectedNodeId);
  }, [turnStatusEvents, selectedNodeId]);
  const timeline = useMemo(
    () => buildNodeTimeline(nodeMessages, nodeToolEvents, nodeStatusEvents),
    [nodeMessages, nodeToolEvents, nodeStatusEvents]
  );
  const autoScrollKey = useMemo(() => buildTimelineUpdateKey(timeline), [timeline]);
  const { handleScroll } = useChatAutoScroll({
    scrollRef: scrollViewRef,
    enabled: activeTab === 'chat',
    updateKey: autoScrollKey,
    resetKey: selectedNodeId ?? '',
  });

  // Animation values
  const translateY = useSharedValue(maxTranslateY); // Start collapsed
  const context = useSharedValue({ y: 0 });

  // Reset to collapsed state when node changes or opens, but animate if needed
  useEffect(() => {
    if (inspectorOpen) {
      // Start at collapsed state when opening
      translateY.value = maxTranslateY;
    }
  }, [inspectorOpen, maxTranslateY]);

  useEffect(() => {
    setMessageText('');
    setMessageError(null);
  }, [selectedNodeId]);

  const handleClose = useCallback(() => {
    setInspectorOpen(false);
  }, [setInspectorOpen]);

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
    const keyboardShift =
      Platform.OS === 'ios'
        ? Math.max(0, keyboard.height.value - bottomOverlayHeight)
        : 0;
    return {
      height: maxHeight, // Fixed layout height
      transform: [{ translateY: translateY.value - keyboardShift }],
    };
  });

  const sendMessage = useCallback(
    async (messageId: string, content: string, interrupt: boolean) => {
      if (!run || !selectedNodeId) {
        const errorText = 'Start a run to send messages.';
        console.warn('[inspector] cannot send message without active run');
        setMessageError(errorText);
        if (selectedNodeId) {
          updateChatMessageStatus(selectedNodeId, messageId, {
            pending: false,
            sendError: errorText,
          });
        }
        return;
      }

      try {
        await api.sendMessage(run.id, selectedNodeId, content, interrupt);
        updateChatMessageStatus(selectedNodeId, messageId, { pending: false });
      } catch (err) {
        const errorText =
          err instanceof Error ? err.message : 'Failed to send message.';
        console.error('[inspector] failed to send message:', err);
        updateChatMessageStatus(selectedNodeId, messageId, {
          pending: false,
          sendError: errorText,
        });
      }
    },
    [run, selectedNodeId, updateChatMessageStatus]
  );

  const handleResetContext = useCallback(() => {
    if (!selectedNodeId) return;
    clearNodeMessages(selectedNodeId);
    setMessageText('');
    setMessageError(null);
    if (!run) {
      const errorText = 'Start a run to reset context.';
      console.warn('[inspector] cannot reset context without active run');
      setMessageError(errorText);
      return;
    }
    api.resetNode(run.id, selectedNodeId).catch((err) => {
      console.error('[inspector] failed to reset context:', err);
      setMessageError('Failed to reset context.');
    });
  }, [clearNodeMessages, run, selectedNodeId]);

  const handleSendMessage = useCallback(
    (interrupt: boolean) => {
      const content = messageText.trim();
      if (!content || !selectedNodeId) return;

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

      const messageId = `local-${crypto.randomUUID()}`;
      const message: ChatMessage = {
        id: messageId,
        nodeId: selectedNodeId,
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
    [messageText, selectedNodeId, selectedNode, run, addChatMessage, sendMessage, handleResetContext]
  );

  const handleRetry = useCallback(
    (message: ChatMessage) => {
      if (!selectedNodeId) return;
      updateChatMessageStatus(selectedNodeId, message.id, {
        pending: true,
        sendError: undefined,
      });
      setMessageError(null);
      void sendMessage(message.id, message.content, message.interrupt ?? true);
    },
    [selectedNodeId, updateChatMessageStatus, sendMessage]
  );

  const isStreaming = useMemo(() => {
    const lastMessage = [...timeline].reverse().find((item) => item.type === 'message');
    return Boolean(
      lastMessage?.type === 'message' &&
        (lastMessage.data.streaming || lastMessage.data.thinkingStreaming)
    );
  }, [timeline]);

  if (!inspectorOpen || !selectedNode) {
    return null;
  }

  return (
    <Animated.View style={[styles.keyboardAvoid, { bottom: bottomOverlayHeight }]}>
      <GestureDetector gesture={dragGesture}>
        <Animated.View style={[styles.container, animatedStyle]}>
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
                  { backgroundColor: STATUS_COLORS[selectedNode.status] ?? '#6b7280' },
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

          {/* Content */}
          {activeTab === 'chat' ? (
            <View style={styles.chatContainer}>
              <ScrollView
                ref={scrollViewRef}
                style={styles.messagesContainer}
                contentContainerStyle={styles.messagesContent}
                onScroll={handleScroll}
                scrollEventThrottle={16}
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
                    {selectedNode.status === 'running' && !isStreaming && (
                      <View style={styles.thinkingPlaceholder}>
                        <View style={styles.thinkingHeader}>
                          <Text style={styles.thinkingRole}>assistant</Text>
                          <View style={styles.metaItem}>
                            <ThinkingSpinner size="sm" color="#4de6a8" />
                            <Text style={styles.metaTextThinking}>thinking</Text>
                          </View>
                        </View>
                        <View style={styles.thinkingBody}>
                          <ThinkingSpinner size="lg" color="#4de6a8" />
                        </View>
                      </View>
                    )}
                  </>
                )}
              </ScrollView>

              <View style={styles.inputContainer}>
                <TextInput
                  style={styles.input}
                  value={messageText}
                  onChangeText={(value) => {
                    setMessageText(value);
                    if (messageError) {
                      setMessageError(null);
                    }
                  }}
                  placeholder="Send message to node..."
                  placeholderTextColor="#555"
                  multiline
                  maxLength={4000}
                />
                {messageError && <Text style={styles.errorText}>{messageError}</Text>}
                <View style={styles.inputActions}>
                  <Pressable
                    style={[
                      styles.actionButton,
                      !messageText.trim() && styles.actionButtonDisabled,
                    ]}
                    onPress={() => handleSendMessage(false)}
                    disabled={!messageText.trim()}
                  >
                    <Text style={styles.actionText}>Queue</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.actionButton,
                      styles.actionButtonPrimary,
                      !messageText.trim() && styles.actionButtonDisabled,
                    ]}
                    onPress={() => handleSendMessage(true)}
                    disabled={!messageText.trim()}
                  >
                    <Text style={styles.actionTextPrimary}>Interrupt</Text>
                  </Pressable>
                </View>
              </View>
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
                  {selectedNode.capabilities?.spawnNodes && <Badge label="Spawn" />}
                  {selectedNode.capabilities?.writeCode && <Badge label="Code" />}
                  {selectedNode.capabilities?.writeDocs && <Badge label="Docs" />}
                  {selectedNode.capabilities?.runCommands && <Badge label="Commands" />}
                  {selectedNode.capabilities?.delegateOnly && <Badge label="Delegate" />}
                </View>
              </View>
            </ScrollView>
          )}
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

type TimelineEvent =
  | { type: 'message'; data: ChatMessage }
  | { type: 'tool'; data: ToolEvent }
  | { type: 'status'; data: TurnStatusEvent };

function buildNodeTimeline(
  messages: ChatMessage[],
  tools: ToolEvent[],
  statuses: TurnStatusEvent[]
): TimelineEvent[] {
  const timeline: TimelineEvent[] = [
    ...messages.map((message) => ({ type: 'message' as const, data: message })),
    ...tools.map((tool) => ({ type: 'tool' as const, data: tool })),
    ...statuses.map((status) => ({ type: 'status' as const, data: status })),
  ];

  return timeline.sort((a, b) => {
    const timeA = new Date(a.type === 'message' ? a.data.createdAt : a.data.timestamp).getTime();
    const timeB = new Date(b.type === 'message' ? b.data.createdAt : b.data.timestamp).getTime();
    return timeA - timeB;
  });
}

function buildTimelineUpdateKey(timeline: TimelineEvent[]): string {
  const lastItem = timeline[timeline.length - 1];
  if (!lastItem) return '';
  if (lastItem.type === 'message') {
    const thinkingLength = lastItem.data.thinking?.length ?? 0;
    return `${lastItem.data.id}-${lastItem.data.createdAt}-${lastItem.data.content.length}-${thinkingLength}`;
  }
  return `${lastItem.data.id}-${lastItem.data.timestamp}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
}

function formatTurnSummary(status: TurnStatusEvent['status'], detail?: string): string {
  if (detail && detail.trim().length > 0) {
    return detail;
  }
  switch (status) {
    case 'turn.started':
      return 'turn started';
    case 'waiting_for_model':
      return 'waiting for model';
    case 'tool.pending':
      return 'tool pending';
    case 'awaiting_approval':
      return 'awaiting approval';
    case 'turn.completed':
      return 'turn completed';
    case 'turn.interrupted':
      return 'turn interrupted';
    case 'turn.failed':
      return 'turn failed';
    default:
      return 'turn update';
  }
}

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
              <ThinkingSpinner size="sm" color="#94a3b8" />
              <Text style={styles.metaText}>sending</Text>
            </View>
          )}
          {hasError && <Text style={styles.errorBadge}>Failed</Text>}
          {message.streaming && !message.thinkingStreaming && (
            <View style={styles.metaItem}>
              <ThinkingSpinner size="sm" color="#60a5fa" />
              <Text style={styles.metaTextStreaming}>streaming</Text>
            </View>
          )}
          {message.thinkingStreaming && (
            <View style={styles.metaItem}>
              <ThinkingSpinner size="sm" color="#4de6a8" />
              <Text style={styles.metaTextThinking}>thinking</Text>
            </View>
          )}
          {message.status === 'interrupted' && (
            <Text style={styles.interruptedText}>interrupted</Text>
          )}
          <Text style={styles.messageTime}>{formatTime(message.createdAt)}</Text>
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
            <Text style={styles.thinkingContent}>{message.thinking ?? ''}</Text>
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
      <Text style={styles.statusTime}>{formatTime(event.timestamp)}</Text>
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
        <Text style={styles.toolTime}>{formatTime(event.timestamp)}</Text>
      </Pressable>

      {expanded && (
        <View style={styles.toolBody}>
          <Text style={styles.toolSectionLabel}>Arguments</Text>
          <Text style={[styles.toolCode, styles.mono]}>{argsText}</Text>

          {hasError && event.error?.message && (
            <>
              <Text style={[styles.toolSectionLabel, styles.toolErrorLabel]}>Error</Text>
              <Text style={[styles.toolCode, styles.toolErrorText, styles.mono]}>
                {event.error.message}
              </Text>
            </>
          )}

          {isCompleted && resultText && (
            <>
              <Text style={styles.toolSectionLabel}>Result</Text>
              <Text style={[styles.toolCode, styles.mono]}>{resultText}</Text>
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
      <Text style={[styles.detailValue, mono && styles.mono]}>{value}</Text>
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

const STATUS_COLORS: Record<string, string> = {
  idle: '#6b7280',
  running: '#22c55e',
  blocked: '#eab308',
  failed: '#ef4444',
};

const styles = StyleSheet.create({
  keyboardAvoid: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  container: {
    backgroundColor: '#1a1a1a',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderColor: '#2a2a2a',
    overflow: 'hidden',
  },
  handleContainer: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: '#444',
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
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  closeButton: {
    padding: 4,
  },
  closeText: {
    color: '#888',
    fontSize: 24,
    lineHeight: 24,
  },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#3b82f6',
  },
  tabText: {
    color: '#666',
    fontSize: 14,
  },
  tabTextActive: {
    color: '#3b82f6',
    fontWeight: '600',
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
    color: '#6b7280',
    textAlign: 'center',
    paddingVertical: 20,
  },
  messageCard: {
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: '#1f1f1f',
  },
  messageUser: {
    alignSelf: 'flex-end',
    maxWidth: '88%',
    borderColor: '#2a2a2a',
  },
  messageAssistant: {
    alignSelf: 'stretch',
    backgroundColor: 'transparent',
    paddingHorizontal: 0,
  },
  messageStreaming: {
    borderLeftWidth: 2,
    borderLeftColor: '#60a5fa',
    paddingLeft: 10,
  },
  messageThinking: {
    borderLeftWidth: 2,
    borderLeftColor: '#4de6a8',
    paddingLeft: 10,
  },
  messagePending: {
    opacity: 0.7,
  },
  messageError: {
    borderColor: '#ef4444',
  },
  messageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  messageRole: {
    color: '#9ca3af',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  messageMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  messageText: {
    color: '#fff',
    fontSize: 14,
    lineHeight: 20,
  },
  messageTime: {
    color: '#6b7280',
    fontSize: 10,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    color: '#94a3b8',
    fontSize: 10,
  },
  metaTextStreaming: {
    color: '#60a5fa',
    fontSize: 10,
  },
  metaTextThinking: {
    color: '#4de6a8',
    fontSize: 10,
  },
  interruptedText: {
    color: '#c4a67a',
    fontSize: 10,
  },
  errorBadge: {
    color: '#ef4444',
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    backgroundColor: 'rgba(239,68,68,0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  thinkingSection: {
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 8,
  },
  thinkingSectionActive: {
    borderColor: '#4de6a8',
    backgroundColor: 'rgba(77,230,168,0.05)',
  },
  thinkingToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#222',
  },
  thinkingToggleIcon: {
    color: '#9ca3af',
    fontSize: 12,
  },
  thinkingToggleLabel: {
    color: '#9ca3af',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  thinkingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#4de6a8',
  },
  thinkingContent: {
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
    backgroundColor: '#151515',
    color: '#9ca3af',
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
    borderTopColor: '#2a2a2a',
  },
  retryButton: {
    borderWidth: 1,
    borderColor: '#ef4444',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  retryText: {
    color: '#ef4444',
    fontSize: 12,
  },
  retryErrorText: {
    color: '#ef4444',
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
    borderColor: '#2a2a2a',
    backgroundColor: '#151515',
  },
  statusLabel: {
    color: '#9ca3af',
    fontSize: 12,
  },
  statusTime: {
    color: '#6b7280',
    fontSize: 10,
  },
  toolCard: {
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 12,
    backgroundColor: '#171717',
    overflow: 'hidden',
  },
  toolCardError: {
    borderColor: '#ef4444',
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
    color: '#9ca3af',
    fontSize: 12,
  },
  toolName: {
    color: '#fff',
    fontSize: 12,
    flexShrink: 1,
  },
  toolStatus: {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  toolStatusProposed: {
    color: '#94a3b8',
  },
  toolStatusStarted: {
    color: '#60a5fa',
  },
  toolStatusCompleted: {
    color: '#22c55e',
  },
  toolStatusFailed: {
    color: '#ef4444',
  },
  toolTime: {
    color: '#6b7280',
    fontSize: 10,
  },
  toolBody: {
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
    gap: 8,
  },
  toolSectionLabel: {
    color: '#9ca3af',
    fontSize: 10,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  toolCode: {
    color: '#e2e8f0',
    fontSize: 11,
    lineHeight: 16,
  },
  toolErrorLabel: {
    color: '#ef4444',
  },
  toolErrorText: {
    color: '#ef4444',
  },
  thinkingPlaceholder: {
    borderLeftWidth: 2,
    borderLeftColor: '#4de6a8',
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
    color: '#9ca3af',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  thinkingBody: {
    paddingVertical: 6,
  },
  inputContainer: {
    padding: 12,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
  },
  input: {
    backgroundColor: '#2a2a2a',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 14,
    maxHeight: 120,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 12,
  },
  inputActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#3b3b3b',
    borderRadius: 16,
    paddingVertical: 8,
    alignItems: 'center',
  },
  actionButtonPrimary: {
    backgroundColor: '#3b82f6',
    borderColor: '#3b82f6',
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  actionText: {
    color: '#cbd5f5',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  actionTextPrimary: {
    color: '#fff',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
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
    borderBottomColor: '#2a2a2a',
  },
  detailLabel: {
    color: '#888',
    fontSize: 14,
  },
  detailValue: {
    color: '#fff',
    fontSize: 14,
  },
  mono: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  capabilitiesSection: {
    marginTop: 16,
  },
  sectionTitle: {
    color: '#888',
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
    backgroundColor: '#2a2a2a',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  badgeText: {
    color: '#888',
    fontSize: 12,
  },
});
