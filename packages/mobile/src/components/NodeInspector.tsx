import { useCallback, useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  Animated as RNAnimated,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGraphStore, type ChatMessage } from '@/stores/graph-store';
import { api } from '@/lib/api';
import { useChatAutoScroll } from '@/lib/useChatAutoScroll';

const MIN_HEIGHT = 120;
const SNAP_THRESHOLD = 50;

export function NodeInspector() {
  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const maxHeight = screenHeight * 0.7;
  const collapsedHeight = MIN_HEIGHT + (Platform.OS === 'ios' ? 0 : 0); // content height
  
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
  const streamingContent = useGraphStore((s) => s.streamingContent);
  const setInspectorOpen = useGraphStore((s) => s.setInspectorOpen);
  const addChatMessage = useGraphStore((s) => s.addChatMessage);

  const [messageText, setMessageText] = useState('');
  const [activeTab, setActiveTab] = useState<'chat' | 'details'>('chat');
  const scrollViewRef = useRef<ScrollView>(null);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const nodeMessages = selectedNodeId ? chatMessages[selectedNodeId] ?? [] : [];
  const nodeStreaming = selectedNodeId ? streamingContent[selectedNodeId] : undefined;
  const autoScrollKey = `${selectedNodeId ?? ''}-${nodeMessages.length}-${nodeStreaming?.length ?? 0}`;
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

  const animatedStyle = useAnimatedStyle(() => ({
    height: maxHeight, // Fixed layout height
    transform: [{ translateY: translateY.value }],
  }));

  const handleSendMessage = useCallback(async () => {
    if (!messageText.trim() || !run || !selectedNodeId) return;

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      nodeId: selectedNodeId,
      role: 'user',
      content: messageText.trim(),
      timestamp: new Date().toISOString(),
    };

    addChatMessage(message);
    setMessageText('');

    try {
      await api.sendMessage(run.id, selectedNodeId, message.content);
    } catch (err) {
      console.error('[inspector] failed to send message:', err);
    }
  }, [messageText, run, selectedNodeId, addChatMessage]);

  if (!inspectorOpen || !selectedNode) {
    return null;
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.keyboardAvoid}
      keyboardVerticalOffset={insets.bottom}
    >
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
                {nodeMessages.length === 0 && !nodeStreaming && (
                  <Text style={styles.emptyText}>No messages yet. Send a message to this node.</Text>
                )}
                {nodeMessages.map((msg) => (
                  <View
                    key={msg.id}
                    style={[
                      styles.message,
                      msg.role === 'user' ? styles.messageUser : styles.messageAssistant,
                    ]}
                  >
                    <Text style={styles.messageText}>{msg.content}</Text>
                    <Text style={styles.messageTime}>
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </Text>
                  </View>
                ))}
                {nodeStreaming && (
                  <View style={[styles.message, styles.messageAssistant]}>
                    <Text style={styles.messageText}>{nodeStreaming}</Text>
                    <Text style={styles.streamingIndicator}>●●●</Text>
                  </View>
                )}
              </ScrollView>

              <View style={styles.inputContainer}>
                <TextInput
                  style={styles.input}
                  value={messageText}
                  onChangeText={setMessageText}
                  placeholder="Send a message..."
                  placeholderTextColor="#555"
                  multiline
                  maxLength={4000}
                  returnKeyType="send"
                  onSubmitEditing={handleSendMessage}
                />
                <Pressable
                  style={[styles.sendButton, !messageText.trim() && styles.sendButtonDisabled]}
                  onPress={handleSendMessage}
                  disabled={!messageText.trim()}
                >
                  <Text style={styles.sendText}>↑</Text>
                </Pressable>
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
    </KeyboardAvoidingView>
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
    gap: 8,
  },
  emptyText: {
    color: '#555',
    textAlign: 'center',
    paddingVertical: 20,
  },
  message: {
    maxWidth: '85%',
    padding: 10,
    borderRadius: 12,
  },
  messageUser: {
    alignSelf: 'flex-end',
    backgroundColor: '#3b82f6',
  },
  messageAssistant: {
    alignSelf: 'flex-start',
    backgroundColor: '#2a2a2a',
  },
  messageText: {
    color: '#fff',
    fontSize: 14,
    lineHeight: 20,
  },
  messageTime: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 10,
    marginTop: 4,
    textAlign: 'right',
  },
  streamingIndicator: {
    color: '#3b82f6',
    fontSize: 10,
    marginTop: 4,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
  },
  input: {
    flex: 1,
    backgroundColor: '#2a2a2a',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 14,
    maxHeight: 100,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#3b82f6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#333',
  },
  sendText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
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
