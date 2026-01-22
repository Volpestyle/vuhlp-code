import { useCallback, useEffect, useMemo, memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Gesture, GestureDetector, TouchableOpacity } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  runOnJS,
} from 'react-native-reanimated';
import type { VisualNode, Point } from '@/stores/graph-store';
import { colors, getStatusColor, getProviderColors, fontFamily } from '@/lib/theme';
import { Expand } from 'iconoir-react-native';
import { formatRelativeTime } from '@vuhlp/shared';

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  custom: 'Custom',
};

import type { SharedValue } from 'react-native-reanimated';

interface NodeCardProps {
  node: VisualNode;
  viewportZoom: number;
  onPress: (nodeId: string) => void;
  onDrag: (nodeId: string, x: number, y: number) => void;
  onPortDragStart: (nodeId: string, portIndex: number, point: Point) => void;
  onPortDragMove: (point: Point) => void;
  onPortDragEnd: (targetNodeId: string | null, targetPortIndex: number | null) => void;
  onExpand: (nodeId: string) => void;
  sharedNodes: SharedValue<Record<string, { position: Point; dimensions: { width: number; height: number } }>>;
  activeDragNodeId: SharedValue<string | null>;
}

const PORT_SIZE = 16;
const PORT_HIT_SLOP = 12;

export const NodeCard = memo(function NodeCard({
  node,
  viewportZoom,
  onPress,
  onDrag,
  onPortDragStart,
  onPortDragMove,
  onPortDragEnd,
  onExpand,
  sharedNodes,
  activeDragNodeId,
}: NodeCardProps) {
  const { position, dimensions, status, label, summary, selected, provider, roleTemplate, lastActivityAt } = node;
  const effectiveZoom = Math.max(0.1, viewportZoom);

  const providerColors = useMemo(() => getProviderColors(provider), [provider]);

  const translateX = useSharedValue(position.x);
  const translateY = useSharedValue(position.y);
  const savedX = useSharedValue(position.x);
  const savedY = useSharedValue(position.y);
  const isDragging = useSharedValue(false);
  
  // Edge drag state
  const draggingPortIndex = useSharedValue<number | null>(null);
  const draggingPortStartPos = useSharedValue<Point | null>(null);

  // Calculate port positions relative to node
  const ports = useMemo(() => [
    { x: dimensions.width / 2 - PORT_SIZE / 2, y: -PORT_SIZE / 2, index: 0 }, // top
    { x: dimensions.width - PORT_SIZE / 2, y: dimensions.height / 2 - PORT_SIZE / 2, index: 1 }, // right
    { x: dimensions.width / 2 - PORT_SIZE / 2, y: dimensions.height - PORT_SIZE / 2, index: 2 }, // bottom
    { x: -PORT_SIZE / 2, y: dimensions.height / 2 - PORT_SIZE / 2, index: 3 }, // left
  ], [dimensions.width, dimensions.height]);

  // Port positions in local (node) coordinates for hit testing
  // And calculation of world coordinates for drag start
  const getPortWorldPos = useCallback((index: number) => {
    'worklet';
    const portPositions = [
      { x: position.x + dimensions.width / 2, y: position.y }, // top
      { x: position.x + dimensions.width, y: position.y + dimensions.height / 2 }, // right
      { x: position.x + dimensions.width / 2, y: position.y + dimensions.height }, // bottom
      { x: position.x, y: position.y + dimensions.height / 2 }, // left
    ];
    return portPositions[index] ?? portPositions[0]!;
  }, [position.x, position.y, dimensions.width, dimensions.height]);

  // Sync position changes from store
  useEffect(() => {
    if (isDragging.value) return;
    translateX.value = position.x;
    translateY.value = position.y;
  }, [position.x, position.y, translateX, translateY, isDragging]);

  const handleDragEnd = useCallback(
    (x: number, y: number) => {
      onDrag(node.id, x, y);
    },
    [onDrag, node.id]
  );

  const handlePress = useCallback(() => {
    onPress(node.id);
  }, [onPress, node.id]);

  const handleExpand = useCallback(() => {
    onExpand(node.id);
  }, [onExpand, node.id]);

  const dragGesture = useMemo(() => Gesture.Pan()
    .maxPointers(1)
    .onStart((e) => {
      'worklet';
      // Check if we hit a port
      const hitRadius = (PORT_SIZE / 2 + PORT_HIT_SLOP) / effectiveZoom;
      const localX = e.x / effectiveZoom;
      const localY = e.y / effectiveZoom;
      let hitPortIndex = -1;

      for (const port of ports) {
        const centerX = port.x + PORT_SIZE / 2;
        const centerY = port.y + PORT_SIZE / 2;
        if (Math.abs(localX - centerX) <= hitRadius && Math.abs(localY - centerY) <= hitRadius) {
          hitPortIndex = port.index;
          break;
        }
      }

      if (hitPortIndex !== -1) {
        // Edge drag start
        draggingPortIndex.value = hitPortIndex;
        const worldPos = getPortWorldPos(hitPortIndex);
        draggingPortStartPos.value = worldPos;
        runOnJS(onPortDragStart)(node.id, hitPortIndex, worldPos);
      } else {
        // Node drag start
        isDragging.value = true;
        activeDragNodeId.value = node.id;
        savedX.value = translateX.value;
        savedY.value = translateY.value;
      }
    })
    .onUpdate((e) => {
      'worklet';
      if (draggingPortIndex.value !== null && draggingPortStartPos.value) {
        // Edge drag update
        const startPos = draggingPortStartPos.value;
        const currentPos = {
          x: startPos.x + e.translationX / effectiveZoom,
          y: startPos.y + e.translationY / effectiveZoom,
        };
        runOnJS(onPortDragMove)(currentPos);
      } else if (isDragging.value) {
        // Node drag update
        const nextX = savedX.value + e.translationX / effectiveZoom;
        const nextY = savedY.value + e.translationY / effectiveZoom;
        translateX.value = nextX;
        translateY.value = nextY;
        
        // Update shared state for edges
        const current = sharedNodes.value;
        const newNodeState = {
          position: { x: nextX, y: nextY },
          dimensions: { width: dimensions.width, height: dimensions.height },
        };
        const nextNodes = { ...current };
        nextNodes[node.id] = newNodeState;
        sharedNodes.value = nextNodes;
      }
    })
    .onEnd(() => {
      'worklet';
      if (draggingPortIndex.value !== null) {
        // Edge drag end
        draggingPortIndex.value = null;
        draggingPortStartPos.value = null;
        runOnJS(onPortDragEnd)(null, null);
      } else if (isDragging.value) {
        // Node drag end
        activeDragNodeId.value = null;
        isDragging.value = false;
        runOnJS(handleDragEnd)(translateX.value, translateY.value);
      }
    })
    .onFinalize(() => {
      'worklet';
      isDragging.value = false;
      activeDragNodeId.value = null;
      draggingPortIndex.value = null;
      draggingPortStartPos.value = null;
    }), [
      node.id, 
      effectiveZoom, 
      ports, 
      draggingPortIndex, 
      draggingPortStartPos, 
      getPortWorldPos, 
      onPortDragStart, 
      onPortDragMove, 
      onPortDragEnd, 
      isDragging, 
      activeDragNodeId, 
      savedX, 
      savedY, 
      translateX, 
      translateY, 
      dimensions, 
      sharedNodes, 
      handleDragEnd
    ]);

  const tapGesture = useMemo(() => Gesture.Tap().onEnd(() => {
    runOnJS(handlePress)();
  }), [handlePress]);

  const composedGesture = useMemo(() => Gesture.Race(dragGesture, tapGesture), [dragGesture, tapGesture]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
    ],
  }));

  const statusColor = getStatusColor(status);

  return (
    <GestureDetector gesture={composedGesture}>
      <Animated.View
        hitSlop={30}
        style={[
          styles.card,
          {
            width: dimensions.width,
            height: dimensions.height,
            borderColor: selected ? colors.accent : colors.borderStrong,
          },
          animatedStyle,
        ]}
      >
        {/* Left border accent */}
        <View style={[styles.leftBorder, { backgroundColor: statusColor }]} />

        {/* Header: Provider badge + role */}
        <View style={styles.header}>
          <View
            style={[
              styles.providerBadge,
              {
                backgroundColor: providerColors.bg,
                borderColor: providerColors.border,
              },
            ]}
          >
            <Text style={[styles.providerText, { color: providerColors.text }]}>
              {PROVIDER_LABELS[provider] ?? 'Custom'}
            </Text>
          </View>
          <Text style={styles.roleTemplate} numberOfLines={1}>
            {roleTemplate}
          </Text>

          <TouchableOpacity 
            onPress={handleExpand}
            hitSlop={8}
            style={styles.expandButton}
          >
            <Expand width={14} height={14} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Title */}
        <Text style={styles.title} numberOfLines={1}>
          {label}
        </Text>

        {/* Summary */}
        <Text style={styles.summary} numberOfLines={2}>
          {summary || 'Waiting...'}
        </Text>

        {/* Footer: Status badge + timestamp */}
        <View style={styles.footer}>
          <View style={styles.statusBadge}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusText, status !== 'idle' && { color: statusColor }]}>
              {status}
            </Text>
          </View>
          <Text style={styles.timestamp}>{formatRelativeTime(lastActivityAt)}</Text>
        </View>

        {/* Streaming indicator */}
        {node.connection?.streaming && (
          <View style={styles.streamingIndicator}>
            <View style={styles.streamingDot} />
          </View>
        )}

        {/* Inbox badge */}
        {node.inboxCount !== undefined && node.inboxCount > 0 && (
          <View style={styles.inboxBadge}>
            <Text style={styles.inboxText}>{node.inboxCount}</Text>
          </View>
        )}

        {/* Connection ports */}
        {ports.map((port) => (
          <View
            key={port.index}
            style={[
              styles.port, 
              { left: port.x, top: port.y }
            ]}
          >
            <View style={styles.portInner} />
          </View>
        ))}
      </Animated.View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    backgroundColor: colors.bgElevated,
    borderRadius: 6,
    borderWidth: 1,
    padding: 12,
    paddingLeft: 15, // Extra padding for left border
  },
  leftBorder: {
    position: 'absolute',
    left: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  providerBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 2,
    borderWidth: 1,
  },
  providerText: {
    fontSize: 10,
    fontFamily: fontFamily.semibold,
    textTransform: 'uppercase',
    letterSpacing: 1.6,
  },
  roleTemplate: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: fontFamily.semibold,
    textTransform: 'uppercase',
    letterSpacing: 1.8,
  },
  expandButton: {
    padding: 2,
    opacity: 0.8,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 12,
    fontFamily: fontFamily.semibold,
    marginBottom: 8,
  },
  summary: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: fontFamily.regular,
    marginBottom: 12,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 2,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  statusDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  statusText: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: fontFamily.semibold,
    textTransform: 'uppercase',
    letterSpacing: 1.6,
  },
  timestamp: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: fontFamily.mono,
    letterSpacing: 0.8,
  },
  streamingIndicator: {
    position: 'absolute',
    top: 8,
    right: 8,
  },
  streamingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.statusRunning,
  },
  inboxBadge: {
    position: 'absolute',
    top: -8,
    right: -8,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    backgroundColor: colors.accent,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
  },
  inboxText: {
    color: colors.bgPrimary,
    fontSize: 10,
    fontFamily: fontFamily.semibold,
  },
  port: {
    position: 'absolute',
    width: PORT_SIZE,
    height: PORT_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
  },
  portInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.bgElevated,
    borderWidth: 2,
    borderColor: colors.borderStrong,
  },
});
