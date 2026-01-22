import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { View, Text, StyleSheet, Platform, NativeSyntheticEvent } from 'react-native';
import ContextMenuView, { type ContextMenuOnPressNativeEvent } from 'react-native-context-menu-view';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  runOnJS,
} from 'react-native-reanimated';
import type { VisualNode, Point } from '@/stores/graph-store';
import { colors, getStatusColor, getProviderColors, fontFamily } from '@/lib/theme';
import { formatRelativeTime } from '@vuhlp/shared';
import type { SharedValue } from 'react-native-reanimated';
import type { GestureType } from 'react-native-gesture-handler';

export type GraphMode = 'move' | 'draw';

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  custom: 'Custom',
};

interface NodeCardProps {
  node: VisualNode;
  mode: GraphMode;
  viewportX: SharedValue<number>;
  viewportY: SharedValue<number>;
  // ... (other props)
  viewportZoom: SharedValue<number>;
  canvasOffset: Point;
  onPress: (nodeId: string) => void;
  onLongPress: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onCanvasGestureStart?: () => void;
  onDrag: (nodeId: string, x: number, y: number) => void;
  onPortDragStart: (nodeId: string, portIndex: number, point: Point) => void;
  onPortDragMove: (point: Point) => void;
  onPortDragEnd: (finalPoint: Point) => void;

  sharedNodes: SharedValue<Record<string, { position: Point; dimensions: { width: number; height: number } }>>;
  activeDragNodeId: SharedValue<string | null>;
  graphPinchGesture?: GestureType;
  isPinching?: SharedValue<boolean>;
}

const PORT_SIZE = 16;
const PORT_HIT_SLOP = 32;

export const NodeCard = memo(function NodeCard({
  node,
  mode,
  viewportX,
  viewportY,
  viewportZoom,
  canvasOffset,
  onPress,
  onLongPress,
  onDelete,
  onCanvasGestureStart,
  onDrag,
  onPortDragStart,
  onPortDragMove,
  onPortDragEnd,
  sharedNodes,
  activeDragNodeId,
  graphPinchGesture,
  isPinching,
}: NodeCardProps) {
  // ... (existing hooks)
  const { position, dimensions, status, label, summary, selected, provider, roleTemplate, lastActivityAt } = node;

  const providerColors = useMemo(() => getProviderColors(provider), [provider]);
  const [debugPortHitIndex, setDebugPortHitIndex] = useState<number | null>(null);
  const debugHitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Port positions in local (node) coordinates
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

  // Find closest port to a local point (for Draw mode)
  const findClosestPortIndex = useCallback((localX: number, localY: number) => {
    'worklet';
    let closestIndex = 0;
    let minDistance = Infinity;

    // Center points of ports in local coords
    const portCenters = [
       { x: dimensions.width / 2, y: 0, index: 0 }, // top
       { x: dimensions.width, y: dimensions.height / 2, index: 1 }, // right
       { x: dimensions.width / 2, y: dimensions.height, index: 2 }, // bottom
       { x: 0, y: dimensions.height / 2, index: 3 }, // left
    ];

    for (const p of portCenters) {
      const dist = Math.hypot(localX - p.x, localY - p.y);
      if (dist < minDistance) {
        minDistance = dist;
        closestIndex = p.index;
      }
    }
    return closestIndex;
  }, [dimensions.width, dimensions.height]);

  // ... (debug helpers and effects) ...
  const triggerPortHitFlash = useCallback((portIndex: number) => {
    if (!__DEV__) return;
    if (debugHitTimeoutRef.current) {
      clearTimeout(debugHitTimeoutRef.current);
      debugHitTimeoutRef.current = null;
    }
    setDebugPortHitIndex(portIndex);
    debugHitTimeoutRef.current = setTimeout(() => {
      setDebugPortHitIndex(null);
      debugHitTimeoutRef.current = null;
    }, 250);
  }, []);

  // Sync position changes from store
  useEffect(() => {
    if (isDragging.value) return;
    translateX.value = position.x;
    translateY.value = position.y;
  }, [position.x, position.y, translateX, translateY, isDragging]);

  useEffect(() => {
    return () => {
      if (debugHitTimeoutRef.current) {
        clearTimeout(debugHitTimeoutRef.current);
      }
    };
  }, []);

  const handleDragEnd = useCallback(
    (x: number, y: number) => {
      onDrag(node.id, x, y);
    },
    [onDrag, node.id]
  );

  const handlePress = useCallback(() => {
    onPress(node.id);
  }, [onPress, node.id]);


  const dragGesture = useMemo(() => Gesture.Pan()
    .maxPointers(1)
    .minDistance(10) // Require some movement before activating to allow context menu long press
    .onStart((e) => {
      'worklet';
      onCanvasGestureStart?.();
      if (isPinching?.value) return;

      const zoom = Math.max(0.1, viewportZoom.value || 1);
      const worldX = (e.absoluteX - canvasOffset.x - viewportX.value) / zoom;
      const worldY = (e.absoluteY - canvasOffset.y - viewportY.value) / zoom;
      const localX = worldX - position.x;
      const localY = worldY - position.y;

      // Logic branch based on mode
      if (mode === 'draw') {
        // Find nearest port to start drawing from
        const closestPortIndex = findClosestPortIndex(localX, localY);
        
        draggingPortIndex.value = closestPortIndex;
        const worldPos = getPortWorldPos(closestPortIndex);
        draggingPortStartPos.value = worldPos;
        runOnJS(onPortDragStart)(node.id, closestPortIndex, worldPos);
        runOnJS(triggerPortHitFlash)(closestPortIndex);

      } else {
        // Move mode - drag the node
        isDragging.value = true;
        activeDragNodeId.value = node.id;
        savedX.value = translateX.value;
        savedY.value = translateY.value;
      }
    })
    .onUpdate((e) => {
      'worklet';
      if (isPinching?.value) return;

      const zoom = Math.max(0.1, viewportZoom.value || 1);
      
      if (draggingPortIndex.value !== null && draggingPortStartPos.value) {
        // Edge drag update (Draw Mode)
        const currentPos = {
          x: (e.absoluteX - canvasOffset.x - viewportX.value) / zoom,
          y: (e.absoluteY - canvasOffset.y - viewportY.value) / zoom,
        };
        runOnJS(onPortDragMove)(currentPos);

      } else if (isDragging.value) {
        // Node drag update (Move Mode)
        const nextX = savedX.value + e.translationX / zoom;
        const nextY = savedY.value + e.translationY / zoom;
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
    .onEnd((e) => {
      'worklet';
      const zoom = Math.max(0.1, viewportZoom.value || 1);

      if (draggingPortIndex.value !== null) {
        // Edge drag end
        const finalPoint = {
          x: (e.absoluteX - canvasOffset.x - viewportX.value) / zoom,
          y: (e.absoluteY - canvasOffset.y - viewportY.value) / zoom,
        };
        draggingPortIndex.value = null;
        draggingPortStartPos.value = null;
        runOnJS(onPortDragEnd)(finalPoint);

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
      mode, // Dependency on mode
      draggingPortIndex,
      draggingPortStartPos,
      getPortWorldPos,
      findClosestPortIndex,
      triggerPortHitFlash,
      onPortDragStart,
      onPortDragMove,
      onPortDragEnd,
      onCanvasGestureStart,
      isDragging,
      activeDragNodeId,
      savedX,
      savedY,
      translateX,
      translateY,
      dimensions,
      sharedNodes,
      handleDragEnd,
      viewportX,
      viewportY,
      viewportZoom,
      canvasOffset,
      position.x,
      position.y
    ]);
  
  // Disable tap gesture in Draw mode to prevent accidental selections when trying to draw
  // Or keep it available? User might want to select node to see context menu.
  // Move mode: Tap OK. Draw mode: Tap OK. 
  // Let's keep tap gesture enabled in both modes for selection.
  const tapGesture = useMemo(() => Gesture.Tap()
    .maxDuration(300) // Fail if held longer than 300ms (allow context menu to take over)
    .onEnd(() => {
      runOnJS(handlePress)();
    }), [handlePress]);

  // Remove long press for edge creation since we have a dedicated mode now?
  // Actually, user said "when line tool is selected, we only draw... when move is selected, we only move".
  // So long press logic in NodeCard (which was for nothing really, maybe context menu) can stay or be removed. 
  // The context menu is handled by the wrapper view on iOS.
  // The existing longPressGesture was effectively specific to the node card logic.
  // We'll keep it but it might be redundant with the mode switch.
  const longPressGesture = useMemo(
    () =>
      Gesture.LongPress()
        .minDuration(450)
        .maxDistance(10)
        .onStart((e) => {
          'worklet';
          // Long press behavior... usually for Context Menu on iOS which intercepts.
          if (Platform.OS === 'ios') return; 
          runOnJS(onLongPress)(node.id);
        }),
    [node.id, onLongPress]
  );

  const composedGesture = useMemo(
    () => {
      const gesture = Gesture.Race(dragGesture, longPressGesture, tapGesture);
      if (graphPinchGesture) {
        return Gesture.Simultaneous(gesture, graphPinchGesture);
      }
      return gesture;
    },
    [dragGesture, longPressGesture, tapGesture, graphPinchGesture]
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
    ],
  }));

  const statusColor = getStatusColor(status);

  const innerContent = (
    <>
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
    </>
  );


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
        {/* Connection ports - Outside ContextMenuView to align with border */}
        {ports.map((port) => (
          <View
            key={port.index}
            style={[
              styles.port, 
              { left: port.x, top: port.y }
            ]}
            pointerEvents="none"
          >
            <View
              style={[
                styles.portInner,
                __DEV__ && debugPortHitIndex === port.index && styles.portInnerHit
              ]}
            />
          </View>
        ))}

        <ContextMenuView
          title={label}
          disabled={Platform.OS !== 'ios'}
          style={styles.contextMenu}
          actions={[
            {
              title: 'Delete',
              destructive: true,
              systemIcon: 'trash',
            },
          ]}
          onPress={(e: NativeSyntheticEvent<ContextMenuOnPressNativeEvent>) => {
            const { name } = e.nativeEvent;
            if (name === 'Delete') {
              runOnJS(onDelete)(node.id);
            }
          }}
        >
          <View style={styles.contentContainer}>
            {innerContent}
          </View>
        </ContextMenuView>
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
    // Padding moved to contentContainer
  },
  contextMenu: {
    flex: 1,
  },
  contentContainer: {
    padding: 12,
    paddingLeft: 15,
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
  portInnerHit: {
    borderColor: colors.accent,
    backgroundColor: colors.accentGlow,
  },
});
