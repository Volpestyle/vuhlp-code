import { useCallback, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  runOnJS,
} from 'react-native-reanimated';
import type { VisualNode, Point } from '@/stores/graph-store';

interface NodeCardProps {
  node: VisualNode;
  viewportZoom: number;
  onPress: () => void;
  onDrag: (x: number, y: number) => void;
  onPortDragStart: (nodeId: string, portIndex: number, point: Point) => void;
  onPortDragMove: (point: Point) => void;
  onPortDragEnd: (targetNodeId: string | null, targetPortIndex: number | null) => void;
}

const STATUS_COLORS: Record<string, string> = {
  idle: '#6b7280',
  running: '#22c55e',
  blocked: '#eab308',
  failed: '#ef4444',
};

const PORT_SIZE = 16;
const PORT_HIT_SLOP = 12;

export function NodeCard({
  node,
  viewportZoom,
  onPress,
  onDrag,
  onPortDragStart,
  onPortDragMove,
  onPortDragEnd,
}: NodeCardProps) {
  const { position, dimensions, status, label, summary, selected } = node;
  const effectiveZoom = Math.max(0.1, viewportZoom);

  const translateX = useSharedValue(position.x);
  const translateY = useSharedValue(position.y);
  const savedX = useSharedValue(position.x);
  const savedY = useSharedValue(position.y);
  const isDragging = useSharedValue(false);

  // Calculate port positions relative to node
  const ports = [
    { x: dimensions.width / 2 - PORT_SIZE / 2, y: -PORT_SIZE / 2, index: 0 }, // top
    { x: dimensions.width - PORT_SIZE / 2, y: dimensions.height / 2 - PORT_SIZE / 2, index: 1 }, // right
    { x: dimensions.width / 2 - PORT_SIZE / 2, y: dimensions.height - PORT_SIZE / 2, index: 2 }, // bottom
    { x: -PORT_SIZE / 2, y: dimensions.height / 2 - PORT_SIZE / 2, index: 3 }, // left
  ];

  // Sync position changes from store
  useEffect(() => {
    if (isDragging.value) return;
    translateX.value = position.x;
    translateY.value = position.y;
  }, [position.x, position.y, translateX, translateY, isDragging]);

  const handleDragEnd = useCallback(
    (x: number, y: number) => {
      onDrag(x, y);
    },
    [onDrag]
  );

  const dragGesture = Gesture.Pan()
    .maxPointers(1)
    .onTouchesDown((event, stateManager) => {
      'worklet';
      const touch = event?.changedTouches?.[0];
      if (!touch) return;
      const hitRadius = PORT_SIZE / 2 + PORT_HIT_SLOP;
      for (let i = 0; i < ports.length; i += 1) {
        const port = ports[i];
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
      runOnJS(onDrag)(nextX, nextY);
    })
    .onEnd(() => {
      runOnJS(handleDragEnd)(translateX.value, translateY.value);
    })
    .onFinalize(() => {
      isDragging.value = false;
    });

  const tapGesture = Gesture.Tap().onEnd(() => {
    runOnJS(onPress)();
  });

  const composedGesture = Gesture.Race(dragGesture, tapGesture);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
    ],
  }));

  const statusColor = STATUS_COLORS[status] ?? STATUS_COLORS.idle;

  return (
    <GestureDetector gesture={composedGesture}>
      <Animated.View
        style={[
          styles.card,
          {
            width: dimensions.width,
            height: dimensions.height,
            borderColor: selected ? '#3b82f6' : '#2a2a2a',
          },
          animatedStyle,
        ]}
      >
        <View style={styles.header}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={styles.label} numberOfLines={1}>
            {label}
          </Text>
        </View>

        <Text style={styles.roleTemplate} numberOfLines={1}>
          {node.roleTemplate}
        </Text>

        <Text style={styles.summary} numberOfLines={3}>
          {summary || 'No activity'}
        </Text>

        <View style={styles.footer}>
          <Text style={styles.status}>{status}</Text>
          {node.inboxCount !== undefined && node.inboxCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{node.inboxCount}</Text>
            </View>
          )}
        </View>

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
}

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
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    borderWidth: 2,
    padding: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  label: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  roleTemplate: {
    color: '#666',
    fontSize: 11,
    fontStyle: 'italic',
    marginBottom: 8,
  },
  summary: {
    flex: 1,
    color: '#888',
    fontSize: 12,
    lineHeight: 16,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  status: {
    color: '#555',
    fontSize: 10,
    textTransform: 'uppercase',
  },
  badge: {
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
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
    backgroundColor: '#333',
    borderWidth: 2,
    borderColor: '#555',
  },
});
