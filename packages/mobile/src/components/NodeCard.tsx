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

interface NodeCardProps {
  node: VisualNode;
  viewportZoom: number;
  onPress: (nodeId: string) => void;
  onDrag: (nodeId: string, x: number, y: number) => void;
  onPortDragStart: (nodeId: string, portIndex: number, point: Point) => void;
  onPortDragMove: (point: Point) => void;
  onPortDragEnd: (targetNodeId: string | null, targetPortIndex: number | null) => void;
  onExpand: (nodeId: string) => void;
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
}: NodeCardProps) {
  const { position, dimensions, status, label, summary, selected, provider, roleTemplate, lastActivityAt } = node;
  const effectiveZoom = Math.max(0.1, viewportZoom);

  const providerColors = useMemo(() => getProviderColors(provider), [provider]);

  const translateX = useSharedValue(position.x);
  const translateY = useSharedValue(position.y);
  const savedX = useSharedValue(position.x);
  const savedY = useSharedValue(position.y);
  const isDragging = useSharedValue(false);

  // Calculate port positions relative to node
  const ports = useMemo(() => [
    { x: dimensions.width / 2 - PORT_SIZE / 2, y: -PORT_SIZE / 2, index: 0 }, // top
    { x: dimensions.width - PORT_SIZE / 2, y: dimensions.height / 2 - PORT_SIZE / 2, index: 1 }, // right
    { x: dimensions.width / 2 - PORT_SIZE / 2, y: dimensions.height - PORT_SIZE / 2, index: 2 }, // bottom
    { x: -PORT_SIZE / 2, y: dimensions.height / 2 - PORT_SIZE / 2, index: 3 }, // left
  ], [dimensions.width, dimensions.height]);

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
    .onTouchesDown((event, stateManager) => {
      'worklet';
      const touch = event?.changedTouches?.[0];
      if (!touch) return;
      const hitRadius = PORT_SIZE / 2 + PORT_HIT_SLOP;
      for (const port of ports) {
        const centerX = port.x + PORT_SIZE / 2;
        const centerY = port.y + PORT_SIZE / 2;
        if (Math.abs(touch.x - centerX) <= hitRadius && Math.abs(touch.y - centerY) <= hitRadius) {
          stateManager.fail();
          return;
        }
      }
    })
    .onStart(() => {
      isDragging.value = true;
      savedX.value = translateX.value;
      savedY.value = translateY.value;
    })
    .onUpdate((e) => {
      const nextX = savedX.value + e.translationX / effectiveZoom;
      const nextY = savedY.value + e.translationY / effectiveZoom;
      translateX.value = nextX;
      translateY.value = nextY;
      runOnJS(onDrag)(node.id, nextX, nextY);
    })
    .onEnd(() => {
      runOnJS(handleDragEnd)(translateX.value, translateY.value);
    })
    .onFinalize(() => {
      isDragging.value = false;
    }), [node.id, effectiveZoom, ports, onDrag, handleDragEnd, isDragging, savedX, savedY, translateX, translateY]);

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
          <Port
            key={port.index}
            nodeId={node.id}
            portIndex={port.index}
            style={{ left: port.x, top: port.y }}
            nodePosition={position}
            nodeDimensions={dimensions}
            viewportZoom={effectiveZoom}
            onDragStart={onPortDragStart}
            onDragMove={onPortDragMove}
            onDragEnd={onPortDragEnd}
          />
        ))}
      </Animated.View>
    </GestureDetector>
  );
});

interface PortProps {
  nodeId: string;
  portIndex: number;
  style: { left: number; top: number };
  nodePosition: Point;
  nodeDimensions: { width: number; height: number };
  viewportZoom: number;
  onDragStart: (nodeId: string, portIndex: number, point: Point) => void;
  onDragMove: (point: Point) => void;
  onDragEnd: (targetNodeId: string | null, targetPortIndex: number | null) => void;
}

function Port({
  nodeId,
  portIndex,
  style,
  nodePosition,
  nodeDimensions,
  viewportZoom,
  onDragStart,
  onDragMove,
  onDragEnd,
}: PortProps) {
  const getWorldPortPosition = useCallback((): Point => {
    const portPositions: Point[] = [
      { x: nodePosition.x + nodeDimensions.width / 2, y: nodePosition.y }, // top
      { x: nodePosition.x + nodeDimensions.width, y: nodePosition.y + nodeDimensions.height / 2 }, // right
      { x: nodePosition.x + nodeDimensions.width / 2, y: nodePosition.y + nodeDimensions.height }, // bottom
      { x: nodePosition.x, y: nodePosition.y + nodeDimensions.height / 2 }, // left
    ];
    const position = portPositions[portIndex];
    return position ?? portPositions[0]!;
  }, [nodePosition, nodeDimensions, portIndex]);

  const handleDragStart = useCallback(() => {
    const worldPos = getWorldPortPosition();
    onDragStart(nodeId, portIndex, worldPos);
  }, [nodeId, portIndex, getWorldPortPosition, onDragStart]);

  const handleDragMove = useCallback(
    (translationX: number, translationY: number) => {
      const worldPos = getWorldPortPosition();
      onDragMove({
        x: worldPos.x + translationX / viewportZoom,
        y: worldPos.y + translationY / viewportZoom,
      });
    },
    [getWorldPortPosition, onDragMove, viewportZoom]
  );

  const handleDragEnd = useCallback(() => {
    // For now, just end without target detection
    // Target detection will be handled by GraphCanvas
    onDragEnd(null, null);
  }, [onDragEnd]);

  const portGesture = Gesture.Pan()
    .maxPointers(1)
    .onStart(() => {
      runOnJS(handleDragStart)();
    })
    .onUpdate((e) => {
      runOnJS(handleDragMove)(e.translationX, e.translationY);
    })
    .onEnd(() => {
      runOnJS(handleDragEnd)();
    });

  return (
    <GestureDetector gesture={portGesture}>
      <View
        style={[styles.port, style]}
        hitSlop={{ top: PORT_HIT_SLOP, right: PORT_HIT_SLOP, bottom: PORT_HIT_SLOP, left: PORT_HIT_SLOP }}
      >
        <View style={styles.portInner} />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    backgroundColor: colors.bgElevated,
    borderRadius: 6,
    borderWidth: 1,
    padding: 12,
    paddingLeft: 15, // Extra padding for left border
    overflow: 'hidden',
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
