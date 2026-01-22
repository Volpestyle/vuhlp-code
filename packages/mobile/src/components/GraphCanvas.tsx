import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, useWindowDimensions, LayoutChangeEvent, Alert, Platform, Pressable } from 'react-native';
import { Canvas, Path, Skia, Group, Circle } from '@shopify/react-native-skia';
import { useFrameCallback } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  useSharedValue,
  useAnimatedStyle,
  withDecay,
  withSpring,
  withTiming,
  withDelay,
  withSequence,
  runOnJS,
  useDerivedValue,
  interpolateColor,
  Easing,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { DragHandGesture, DesignPencil } from 'iconoir-react-native';
import {
  useGraphStore,
  type VisualNode,
  type VisualEdge,
  type Point,
} from '@/stores/graph-store';
import { api } from '@/lib/api';
import { NodeCard, type GraphMode } from './NodeCard';
import { colors, fontFamily, fontSize, spacing, radius } from '@/lib/theme';
import { createUuid } from '@/lib/ids';

// Liquid glass spring config - slightly bouncy for fluid feel
const LIQUID_SPRING = { damping: 15, stiffness: 180, mass: 0.6 };
const TOOLBAR_ICON_SIZE = 48;
const TOOLBAR_PADDING = 4;
const TOOLBAR_GAP = 4;

interface GraphToolbarProps {
  mode: GraphMode;
  onChange: (m: GraphMode) => void;
  panelHeight?: SharedValue<number>;
}

function GraphToolbar({ mode, onChange, panelHeight }: GraphToolbarProps) {
  // 0 = Move (left), 1 = Draw (right)
  const activeIndex = useSharedValue(mode === 'move' ? 0 : 1);
  const labelOpacity = useSharedValue(0);
  const [displayedMode, setDisplayedMode] = useState(mode);
  const isFirstRender = useRef(true);

  useEffect(() => {
    activeIndex.value = withSpring(mode === 'move' ? 0 : 1, LIQUID_SPRING);

    // Skip animation on first render
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    // Update displayed mode and animate label
    setDisplayedMode(mode);
    labelOpacity.value = withSequence(
      withTiming(1, { duration: 150, easing: Easing.out(Easing.ease) }),
      withDelay(800, withTiming(0, { duration: 300, easing: Easing.in(Easing.ease) }))
    );
  }, [mode, activeIndex, labelOpacity]);

  // Sliding indicator style - the liquid glass blob
  const indicatorStyle = useAnimatedStyle(() => {
    const translateX = activeIndex.value * (TOOLBAR_ICON_SIZE + TOOLBAR_GAP);
    // Subtle morph during transition for liquid effect
    const progress = activeIndex.value;
    const midPoint = Math.abs(progress - 0.5) * 2;
    const stretchFactor = 1 + (1 - midPoint) * 0.12;

    return {
      transform: [
        { translateX },
        { scaleX: stretchFactor },
      ],
    };
  });

  // Label fade animation
  const labelStyle = useAnimatedStyle(() => ({
    opacity: labelOpacity.value,
    transform: [
      { translateY: (1 - labelOpacity.value) * -4 },
    ],
  }));

  // Animated top position based on controls panel height
  const toolbarPositionStyle = useAnimatedStyle(() => ({
    top: (panelHeight?.value ?? 40) + 12,
  }));

  return (
    <Animated.View style={[styles.toolbarWrapper, toolbarPositionStyle]}>
      <View style={styles.toolbarContainer}>
        {/* Blur background */}
        {Platform.OS === 'ios' ? (
          <BlurView intensity={60} style={[StyleSheet.absoluteFill, styles.toolbarBlur]} tint="dark" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.toolbarBlur, { backgroundColor: colors.glassBg }]} />
        )}
        {/* Dark overlay for contrast */}
        <View style={[StyleSheet.absoluteFill, styles.toolbarOverlay]} />
        {/* Top highlight edge */}
        <View style={styles.toolbarHighlight} />

        {/* Content wrapper */}
        <View style={styles.toolbarContent}>
          {/* Sliding liquid glass indicator */}
          <Animated.View style={[styles.liquidIndicator, indicatorStyle]}>
            <View style={styles.liquidIndicatorShimmer} />
          </Animated.View>

          {/* Move button */}
          <Pressable onPress={() => onChange('move')} style={styles.toolbarIconBtn}>
            <DragHandGesture
              width={22}
              height={22}
              color={mode === 'move' ? colors.accent : colors.textMuted}
              strokeWidth={1.5}
            />
          </Pressable>

          {/* Draw button */}
          <Pressable onPress={() => onChange('draw')} style={styles.toolbarIconBtn}>
            <DesignPencil
              width={22}
              height={22}
              color={mode === 'draw' ? colors.accent : colors.textMuted}
              strokeWidth={1.5}
            />
          </Pressable>
        </View>
      </View>

      {/* Mode label - fades in/out on change */}
      <Animated.Text style={[styles.toolbarLabel, labelStyle]}>
        {displayedMode === 'move' ? 'Move' : 'Draw'}
      </Animated.Text>
    </Animated.View>
  );
}

const SPRING_CONFIG = {
  damping: 20,
  stiffness: 200,
};

const EDGE_SNAP_RADIUS = 60; // Larger snap radius for mobile touch precision
const EDGE_HIT_RADIUS = 16;
const EDGE_HIT_SAMPLES = 24;
const HANDOFF_ANIMATION_DURATION_MS = 2000;
const MOMENTUM_DECELERATION = 0.997;
const MOMENTUM_VELOCITY_THRESHOLD = 120;

type MomentumStopReason =
  | 'complete'
  | 'pan-start'
  | 'pinch-start'
  | 'tap'
  | 'node-gesture'
  | 'programmatic';

let skiaMissingLogged = false;
let skiaAvailableCache: boolean | null = null;

const isSkiaAvailable = (): boolean => {
  if (skiaAvailableCache !== null) {
    return skiaAvailableCache;
  }
  try {
    const path = Skia.Path.Make();
    skiaAvailableCache = Boolean(path) && Boolean(Skia.Matrix);
  } catch {
    skiaAvailableCache = false;
  }
  return skiaAvailableCache;
};

const logSkiaMissing = () => {
  if (skiaMissingLogged) return;
  skiaMissingLogged = true;
  console.error('[GraphCanvas] Skia API unavailable. Rebuild the dev client to enable graph rendering.');
};

interface GraphCanvasProps {
  viewportX: SharedValue<number>;
  viewportY: SharedValue<number>;
  viewportZoom: SharedValue<number>;
  /** Shared value tracking the controls panel height for toolbar positioning */
  controlsPanelHeight?: SharedValue<number>;
}

export function GraphCanvas(props: GraphCanvasProps) {
  if (!isSkiaAvailable()) {
    logSkiaMissing();
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackTitle}>Graph renderer unavailable</Text>
        <Text style={styles.fallbackText}>
          Skia failed to initialize. Rebuild the dev client to enable the run graph.
        </Text>
      </View>
    );
  }

  return <SkiaGraphCanvas {...props} />;
}

function SkiaGraphCanvas({ viewportX, viewportY, viewportZoom, controlsPanelHeight }: GraphCanvasProps) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [dimensions, setDimensions] = useState({ width: windowWidth, height: windowHeight });
  const [canvasOffset, setCanvasOffset] = useState<Point>({ x: 0, y: 0 });
  const [mode, setMode] = useState<GraphMode>('move');
  const containerRef = useRef<View>(null);

  const run = useGraphStore((s) => s.run);
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const viewport = useGraphStore((s) => s.viewport);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const selectedEdgeId = useGraphStore((s) => s.selectedEdgeId);
  const edgeDrag = useGraphStore((s) => s.edgeDrag);
  const setViewport = useGraphStore((s) => s.setViewport);
  const setViewDimensions = useGraphStore((s) => s.setViewDimensions);
  const selectNode = useGraphStore((s) => s.selectNode);
  const selectEdge = useGraphStore((s) => s.selectEdge);
  const updateNodePosition = useGraphStore((s) => s.updateNodePosition);
  const startEdgeDrag = useGraphStore((s) => s.startEdgeDrag);
  const updateEdgeDrag = useGraphStore((s) => s.updateEdgeDrag);
  const endEdgeDrag = useGraphStore((s) => s.endEdgeDrag);
  const addEdge = useGraphStore((s) => s.addEdge);
  const removeNode = useGraphStore((s) => s.removeNode);
  const removeEdge = useGraphStore((s) => s.removeEdge);
  const recentHandoffs = useGraphStore((s) => s.recentHandoffs);
  const dragRafRef = useRef<number | null>(null);
  const pendingDragRef = useRef<{ id: string; x: number; y: number } | null>(null);

  // Track animation frame time for handoff animations
  const [animationTime, setAnimationTime] = useState(Date.now());
  const animationActiveUntil = useSharedValue(0);

  const nodesById = useMemo(() => {
    const lookup: Record<string, VisualNode> = {};
    for (const node of nodes) {
      lookup[node.id] = node;
    }
    return lookup;
  }, [nodes]);

  // Update animation end time when handoffs change
  useEffect(() => {
    if (recentHandoffs.length === 0) return;

    // Find the latest handoff and set animation to run until it completes
    let latestEnd = 0;
    for (const handoff of recentHandoffs) {
      const endTime = Date.parse(handoff.createdAt) + HANDOFF_ANIMATION_DURATION_MS;
      if (endTime > latestEnd) {
        latestEnd = endTime;
      }
    }
    animationActiveUntil.value = latestEnd;
  }, [recentHandoffs, animationActiveUntil]);

  // Drive handoff animations at ~60fps while active
  useFrameCallback(() => {
    'worklet';
    const now = Date.now();
    // Run slightly longer than the target time to ensure we render one frame
    // where elapsed > duration, which causes the packet to be removed
    if (now < animationActiveUntil.value + 100) {
      runOnJS(setAnimationTime)(now);
    }
  });

  useEffect(() => {
    return () => {
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      pendingDragRef.current = null;
    };
  }, []);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height, x, y } = event.nativeEvent.layout;
      setDimensions({ width, height });
      setViewDimensions({ width, height });
      setCanvasOffset({ x, y });
      requestAnimationFrame(() => {
        containerRef.current?.measureInWindow((absX, absY) => {
          setCanvasOffset({ x: absX, y: absY });
        });
      });
    },
    [setViewDimensions]
  );

  // Animated viewport values provided by parent for coordination
  // const viewportX = useSharedValue(viewport.x);
  // const viewportY = useSharedValue(viewport.y);
  // const viewportZoom = useSharedValue(viewport.zoom);

  // Shared state for nodes to sync edges with gestures
  const sharedNodes = useSharedValue<Record<string, { position: Point; dimensions: ViewDimensions }>>({});
  const activeDragNodeId = useSharedValue<string | null>(null);

  // Shared values for edge drag preview (must update on UI thread for smooth Skia rendering)
  const edgeDragActive = useSharedValue(false);
  const edgeDragFromNodeId = useSharedValue<string | null>(null);
  const edgeDragFromPortIndex = useSharedValue(0);
  const edgeDragCurrentX = useSharedValue(0);
  const edgeDragCurrentY = useSharedValue(0);

  // Sync shared nodes from store, but skip the node currently being dragged to avoid fighting
  useEffect(() => {
    const newSharedNodes = { ...sharedNodes.value };
    let changed = false;

    // Check if we need to update any nodes (skip dragged one)
    for (const node of nodes) {
      if (node.id === activeDragNodeId.value) continue;
      
      const current = newSharedNodes[node.id];
      if (
        !current || 
        current.position.x !== node.position.x || 
        current.position.y !== node.position.y ||
        current.dimensions.width !== node.dimensions.width ||
        current.dimensions.height !== node.dimensions.height
      ) {
        newSharedNodes[node.id] = {
          position: { x: node.position.x, y: node.position.y },
          dimensions: { width: node.dimensions.width, height: node.dimensions.height }
        };
        changed = true;
      }
    }

    // Remove deleted nodes
    const nodeIds = new Set(nodes.map(n => n.id));
    for (const id in newSharedNodes) {
      if (!nodeIds.has(id)) {
        delete newSharedNodes[id];
        changed = true;
      }
    }

    if (changed) {
      sharedNodes.value = newSharedNodes;
    }
  }, [nodes, sharedNodes, activeDragNodeId]);

  // Sync shared values from store (gesture math relies on the latest values)
  // We only sync if no gesture is active to avoid fighting with the UI thread
  const isGestureActive = useSharedValue(false);
  const isPinching = useSharedValue(false);
  const isPanning = useSharedValue(false);
  const panRebasePending = useSharedValue(false);
  const isMomentumActive = useSharedValue(false);
  const momentumAxesRemaining = useSharedValue(0);
  const momentumCancelled = useSharedValue(false);
  const momentumFinalized = useSharedValue(false);
  const momentumStopReason = useSharedValue<MomentumStopReason>('complete');

  useEffect(() => {
    if (!isGestureActive.value) {
      viewportX.value = viewport.x;
      viewportY.value = viewport.y;
      viewportZoom.value = viewport.zoom;
    }
  }, [viewport.x, viewport.y, viewport.zoom, viewportX, viewportY, viewportZoom, isGestureActive]);

  // Track gesture state
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const savedZoom = useSharedValue(1);
  const pinchWorldX = useSharedValue(0);
  const pinchWorldY = useSharedValue(0);
  const lastPinchPointerCount = useSharedValue(0);
  const panTranslationOffsetX = useSharedValue(0);
  const panTranslationOffsetY = useSharedValue(0);

  // Manual double tap detection tracking
  const lastTapX = useSharedValue(0);
  const lastTapY = useSharedValue(0);
  const lastTapTime = useSharedValue(0);

  const logPinchHandoff = useCallback(
    (payload: {
      pointerCount: number;
      previousPointerCount: number;
      focalX: number;
      focalY: number;
      zoom: number;
    }) => {
      console.debug('[graph] pinch handoff rebase', payload);
    },
    []
  );

  const logMomentumStart = useCallback(
    (payload: {
      velocityX: number;
      velocityY: number;
      speed: number;
      deceleration: number;
    }) => {
      console.debug('[graph] pan momentum start', payload);
    },
    []
  );

  const logMomentumStop = useCallback(
    (payload: { reason: MomentumStopReason }) => {
      console.debug('[graph] pan momentum stop', payload);
    },
    []
  );

  const syncViewport = useCallback(() => {
    setViewport({
      x: viewportX.value,
      y: viewportY.value,
      zoom: viewportZoom.value,
      });
  }, [setViewport, viewportX, viewportY, viewportZoom]);

  const finalizeMomentum = useCallback(() => {
    'worklet';
    if (momentumFinalized.value) return;
    momentumFinalized.value = true;
    isMomentumActive.value = false;
    isGestureActive.value = isPinching.value || isPanning.value;
    momentumAxesRemaining.value = 0;
    const reason: MomentumStopReason = momentumCancelled.value
      ? momentumStopReason.value
      : 'complete';
    runOnJS(syncViewport)();
    runOnJS(logMomentumStop)({ reason });
  }, [
    isGestureActive,
    isMomentumActive,
    isPinching,
    isPanning,
    logMomentumStop,
    momentumAxesRemaining,
    momentumCancelled,
    momentumFinalized,
    momentumStopReason,
    syncViewport,
  ]);

  const handleMomentumAxisEnd = useCallback(
    (finished?: boolean) => {
      'worklet';
      if (finished === false) {
        momentumCancelled.value = true;
      }
      const remaining = momentumAxesRemaining.value - 1;
      momentumAxesRemaining.value = remaining;
      if (remaining <= 0) {
        finalizeMomentum();
      }
    },
    [finalizeMomentum, momentumAxesRemaining, momentumCancelled]
  );

  const startMomentum = useCallback(
    (velocityX: number, velocityY: number) => {
      'worklet';
      momentumFinalized.value = false;
      momentumCancelled.value = false;
      momentumStopReason.value = 'complete';
      momentumAxesRemaining.value = 2;
      isMomentumActive.value = true;
      isGestureActive.value = true;
      runOnJS(logMomentumStart)({
        velocityX,
        velocityY,
        speed: Math.hypot(velocityX, velocityY),
        deceleration: MOMENTUM_DECELERATION,
      });
      viewportX.value = withDecay(
        { velocity: velocityX, deceleration: MOMENTUM_DECELERATION },
        handleMomentumAxisEnd
      );
      viewportY.value = withDecay(
        { velocity: velocityY, deceleration: MOMENTUM_DECELERATION },
        handleMomentumAxisEnd
      );
    },
    [
      handleMomentumAxisEnd,
      isGestureActive,
      isMomentumActive,
      logMomentumStart,
      momentumAxesRemaining,
      momentumCancelled,
      momentumFinalized,
      momentumStopReason,
      viewportX,
      viewportY,
    ]
  );

  const cancelMomentum = useCallback(
    (reason: MomentumStopReason) => {
      'worklet';
      if (!isMomentumActive.value) return;
      momentumStopReason.value = reason;
      momentumCancelled.value = true;
      cancelAnimation(viewportX);
      cancelAnimation(viewportY);
      if (momentumAxesRemaining.value <= 0) {
        finalizeMomentum();
      }
    },
    [
      finalizeMomentum,
      isMomentumActive,
      momentumAxesRemaining,
      momentumCancelled,
      momentumStopReason,
      viewportX,
      viewportY,
    ]
  );

  const cancelMomentumForNode = useCallback(() => {
    'worklet';
    cancelMomentum('node-gesture');
  }, [cancelMomentum]);

  // Pinch gesture - always active, works simultaneously with other gestures
  const pinchGesture = useMemo(() => Gesture.Pinch()
    .onStart((e) => {
      cancelMomentum('pinch-start');
      isGestureActive.value = true;
      isPinching.value = true;
      panRebasePending.value = false;
      savedZoom.value = viewportZoom.value;
      const zoom = viewportZoom.value || 1;
      pinchWorldX.value = (e.focalX - viewportX.value) / zoom;
      pinchWorldY.value = (e.focalY - viewportY.value) / zoom;
      lastPinchPointerCount.value = e.numberOfPointers;
    })
    .onUpdate((e) => {
      const pointerCount = e.numberOfPointers;
      if (pointerCount !== lastPinchPointerCount.value) {
        const currentZoom = viewportZoom.value || 1;
        pinchWorldX.value = (e.focalX - viewportX.value) / currentZoom;
        pinchWorldY.value = (e.focalY - viewportY.value) / currentZoom;
        runOnJS(logPinchHandoff)({
          pointerCount,
          previousPointerCount: lastPinchPointerCount.value,
          focalX: e.focalX,
          focalY: e.focalY,
          zoom: currentZoom,
        });
      }
      lastPinchPointerCount.value = pointerCount;
      const nextZoom = Math.max(0.25, Math.min(savedZoom.value * e.scale, 4));
      const focusX = e.focalX;
      const focusY = e.focalY;
      viewportZoom.value = nextZoom;
      viewportX.value = focusX - pinchWorldX.value * nextZoom;
      viewportY.value = focusY - pinchWorldY.value * nextZoom;
    })
    .onEnd(() => {
      isPinching.value = false;
      lastPinchPointerCount.value = 0;
      panRebasePending.value = true;
      if (isPanning.value) {
        savedX.value = viewportX.value;
        savedY.value = viewportY.value;
      }
      isGestureActive.value = isPanning.value || isMomentumActive.value;
      runOnJS(syncViewport)();
    })
    .onFinalize(() => {
      isPinching.value = false;
      lastPinchPointerCount.value = 0;
      isGestureActive.value = isPanning.value || isMomentumActive.value;
    }), [cancelMomentum, viewportX, viewportY, viewportZoom, isGestureActive, isMomentumActive, isPinching, isPanning, panRebasePending, savedZoom, savedX, savedY, pinchWorldX, pinchWorldY, lastPinchPointerCount, panTranslationOffsetX, panTranslationOffsetY, logPinchHandoff, syncViewport]);

  // Pan gesture - single finger allowed now
  const panGesture = useMemo(() => Gesture.Pan()
    .maxPointers(1)
    .minDistance(10) // Require movement before activating to allow long press for edge context menu
    .onStart((e) => {
      cancelMomentum('pan-start');
      isGestureActive.value = true;
      isPanning.value = true;
      savedX.value = viewportX.value;
      savedY.value = viewportY.value;
      panTranslationOffsetX.value = e.translationX;
      panTranslationOffsetY.value = e.translationY;
    })
    .onUpdate((e) => {
      if (panRebasePending.value) {
        savedX.value = viewportX.value;
        savedY.value = viewportY.value;
        panTranslationOffsetX.value = e.translationX;
        panTranslationOffsetY.value = e.translationY;
        panRebasePending.value = false;
        return;
      }
      if (isPinching.value) {
        return;
      }
      const nextX = savedX.value + (e.translationX - panTranslationOffsetX.value);
      const nextY = savedY.value + (e.translationY - panTranslationOffsetY.value);
      viewportX.value = nextX;
      viewportY.value = nextY;
    })
    .onEnd((e) => {
      isPanning.value = false;
      const velocityX = e.velocityX;
      const velocityY = e.velocityY;
      const speed = Math.hypot(velocityX, velocityY);
      if (!isPinching.value && speed > MOMENTUM_VELOCITY_THRESHOLD) {
        startMomentum(velocityX, velocityY);
        return;
      }
      isGestureActive.value = isPinching.value || isMomentumActive.value;
      runOnJS(syncViewport)();
    })
    .onFinalize(() => {
      isPanning.value = false;
      isGestureActive.value = isPinching.value || isMomentumActive.value;
    }), [cancelMomentum, startMomentum, viewportX, viewportY, viewportZoom, isGestureActive, isMomentumActive, isPinching, isPanning, panRebasePending, savedX, savedY, panTranslationOffsetX, panTranslationOffsetY, syncViewport]);

  // Fit to view helper
  const fitToView = useCallback(() => {
    isGestureActive.value = true;
    if (nodes.length === 0) {
      viewportX.value = withSpring(0, SPRING_CONFIG);
      viewportY.value = withSpring(0, SPRING_CONFIG);
      viewportZoom.value = withSpring(1, SPRING_CONFIG, (finished) => {
        if (finished) {
          isGestureActive.value = false;
          runOnJS(syncViewport)();
        }
      });
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + node.dimensions.width);
      maxY = Math.max(maxY, node.position.y + node.dimensions.height);
    }

    const padding = 50;
    const contentWidth = maxX - minX + padding * 2;
    const contentHeight = maxY - minY + padding * 2;
    const contentCenterX = minX - padding + contentWidth / 2;
    const contentCenterY = minY - padding + contentHeight / 2;

    const scaleX = dimensions.width / contentWidth;
    const scaleY = dimensions.height / contentHeight;
    // Limit max zoom to prevent zooming in too close on single small nodes
    const targetZoom = Math.min(scaleX, scaleY, 1.5);

    const targetVx = dimensions.width / 2 - contentCenterX * targetZoom;
    const targetVy = dimensions.height / 2 - contentCenterY * targetZoom;

    viewportX.value = withSpring(targetVx, SPRING_CONFIG);
    viewportY.value = withSpring(targetVy, SPRING_CONFIG);
    viewportZoom.value = withSpring(targetZoom, SPRING_CONFIG, (finished) => {
      if (finished) {
        isGestureActive.value = false;
        runOnJS(syncViewport)();
      }
    });
  }, [nodes, dimensions, viewportX, viewportY, viewportZoom, isGestureActive, syncViewport]);

  // Double tap to reset view
  const handleCanvasTap = useCallback(
    (worldX: number, worldY: number, zoom: number) => {
      if (edgeDrag) {
        return;
      }

      const hitNode = nodes.find((node) => {
        const { x, y } = node.position;
        return (
          worldX >= x &&
          worldX <= x + node.dimensions.width &&
          worldY >= y &&
          worldY <= y + node.dimensions.height
        );
      });

      if (hitNode) {
        selectNode(hitNode.id);
        return;
      }

      const hitRadius = EDGE_HIT_RADIUS / Math.max(zoom, 0.1);
      const hitEdge = findEdgeNearPoint(
        { x: worldX, y: worldY },
        edges,
        nodesById,
        hitRadius
      );

      if (hitEdge) {
        selectEdge(hitEdge.id === selectedEdgeId ? null : hitEdge.id);
        return;
      }

      if (selectedEdgeId !== null) {
        selectEdge(null);
      }
      if (selectedNodeId !== null) {
        selectNode(null);
      }
    },
    [
      edgeDrag,
      nodes,
      edges,
      nodesById,
      selectNode,
      selectEdge,
      selectedEdgeId,
      selectedNodeId,
    ]
  );

  // Platform-agnostic delete node handler (called by Context Menu or Alert)
  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      if (!run) return;
      
      api
        .deleteNode(run.id, nodeId)
        .then(() => removeNode(nodeId))
        .catch((err) => {
          console.error('[graph] failed to delete node:', err);
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          Alert.alert('Delete failed', `Could not delete node: ${errorMessage}`, [{ text: 'OK' }]);
        });
    },
    [run, removeNode]
  );

  const handleNodeLongPress = useCallback(
    (nodeId: string) => {
      // On iOS, we use the ContextMenu, so this long press handler is only a fallback (or Android)
      // If we are on iOS, we might want to ignore this if the ContextMenu handles it, 
      // but ContextMenu usually intercepts the gesture.
      if (Platform.OS === 'ios') return;

      if (!run) {
        console.warn('[graph] cannot delete node without active run', { nodeId });
        Alert.alert('Delete node unavailable', 'Start a run to delete nodes.', [{ text: 'OK' }]);
        return;
      }
      const node = nodesById[nodeId];
      const label = node?.label ?? nodeId.slice(0, 8);
      Alert.alert(
        `Delete node "${label}"?`,
        'This will also remove any connected edges. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => handleDeleteNode(nodeId),
          },
        ]
      );
    },
    [run, nodesById, handleDeleteNode]
  );

  // Handler for edge deletion - used by both context menu and long press (Android)
  const handleEdgeDelete = useCallback(
    (edgeId: string) => {
      if (!run) {
        console.warn('[graph] cannot delete edge without active run', { edgeId });
        Alert.alert('Delete edge unavailable', 'Start a run to delete edges.', [{ text: 'OK' }]);
        return;
      }

      api
        .deleteEdge(run.id, edgeId)
        .then(() => removeEdge(edgeId))
        .catch((err) => {
          console.error('[graph] failed to delete edge:', err);
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          Alert.alert('Delete failed', `Could not delete edge: ${errorMessage}`, [{ text: 'OK' }]);
        });
    },
    [run, removeEdge]
  );

  const handleCanvasLongPress = useCallback(
    (worldX: number, worldY: number, zoom: number) => {
      if (edgeDrag) {
        return;
      }

      // Skip if tapped on a node (nodes handle their own context menus)
      const hitNode = nodes.some((node) => {
        const { x, y } = node.position;
        return (
          worldX >= x &&
          worldX <= x + node.dimensions.width &&
          worldY >= y &&
          worldY <= y + node.dimensions.height
        );
      });
      if (hitNode) {
        return;
      }

      // On iOS, edges use ContextMenuView overlays instead of this gesture
      if (Platform.OS === 'ios') {
        return;
      }

      // Android: use Alert for edge deletion
      const hitRadius = EDGE_HIT_RADIUS / Math.max(zoom, 0.1);
      const hitEdge = findEdgeNearPoint(
        { x: worldX, y: worldY },
        edges,
        nodesById,
        hitRadius
      );
      if (!hitEdge) {
        return;
      }

      const fromLabel = nodesById[hitEdge.from]?.label ?? hitEdge.from.slice(0, 8);
      const toLabel = nodesById[hitEdge.to]?.label ?? hitEdge.to.slice(0, 8);
      const title = `${fromLabel} ${hitEdge.bidirectional ? '↔' : '→'} ${toLabel}`;

      Alert.alert(
        'Delete edge?',
        title,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => handleEdgeDelete(hitEdge.id),
          },
        ]
      );
    },
    [edgeDrag, edges, nodes, nodesById, handleEdgeDelete]
  );


  // Consolidated tap handler for both single and double taps
  // We manually detect double taps to ensure they are close together spatially
  const tapGesture = useMemo(() => Gesture.Tap()
    .maxDuration(250)
    .onEnd((event) => {
      if (isPanning.value || isPinching.value) return;
      if (isMomentumActive.value) {
        cancelMomentum('tap');
        return;
      }

      const now = Date.now();
      const timeDiff = now - lastTapTime.value;
      const dist = Math.hypot(event.x - lastTapX.value, event.y - lastTapY.value);

      // Check for double tap: close in time (<300ms) and space (<40px)
      if (timeDiff < 300 && dist < 40) {
        runOnJS(fitToView)();
        // Reset time to prevent triple-tap confusion
        lastTapTime.value = 0;
      } else {
        // Single tap behavior
        const zoom = viewportZoom.value || 1;
        const worldX = (event.x - viewportX.value) / zoom;
        const worldY = (event.y - viewportY.value) / zoom;
        runOnJS(handleCanvasTap)(worldX, worldY, zoom);

        // Record this tap for potential double tap
        lastTapTime.value = now;
        lastTapX.value = event.x;
        lastTapY.value = event.y;
      }
    }), [cancelMomentum, fitToView, handleCanvasTap, isMomentumActive, isPanning, isPinching, lastTapTime, lastTapX, lastTapY, viewportX, viewportY, viewportZoom]);

  const longPressGesture = useMemo(() => Gesture.LongPress()
    .minDuration(450)
    .maxDistance(12)
    .onStart((event) => {
      'worklet';
      if (isPanning.value || isPinching.value) return;
      if (isMomentumActive.value) {
        cancelMomentum('tap');
        return;
      }
      const zoom = viewportZoom.value || 1;
      const worldX = (event.x - viewportX.value) / zoom;
      const worldY = (event.y - viewportY.value) / zoom;
      runOnJS(handleCanvasLongPress)(worldX, worldY, zoom);
    }), [cancelMomentum, isMomentumActive, isPanning, isPinching, viewportZoom, viewportX, viewportY, handleCanvasLongPress]);

  // Compose gestures:
  // - Pinch always works (simultaneous with pan for two-finger navigation)
  // - Pan is exclusive with tap gestures (dragging won't trigger tap)
  const composedGesture = useMemo(() => {
    const exclusiveGesture = Platform.OS === 'ios'
      ? Gesture.Exclusive(panGesture, tapGesture)
      : Gesture.Exclusive(panGesture, longPressGesture, tapGesture);

    return Gesture.Simultaneous(
      pinchGesture,
      exclusiveGesture
    );
  }, [pinchGesture, panGesture, longPressGesture, tapGesture]);

  // Port drag handlers
  const handlePortDragStart = useCallback(
    (nodeId: string, portIndex: number, point: Point) => {
      console.debug('[graph] edge drag start', { nodeId, portIndex, point });
      // Update shared values for smooth Skia preview rendering
      edgeDragActive.value = true;
      edgeDragFromNodeId.value = nodeId;
      edgeDragFromPortIndex.value = portIndex;
      edgeDragCurrentX.value = point.x;
      edgeDragCurrentY.value = point.y;
      // Also update store for state management
      startEdgeDrag(nodeId, portIndex, point);
    },
    [startEdgeDrag]
  );

  const handlePortDragMove = useCallback(
    (point: Point) => {
      // Update shared values directly for smooth preview
      edgeDragCurrentX.value = point.x;
      edgeDragCurrentY.value = point.y;
    },
    []
  );

  // Find closest port to a point
  const findClosestPort = useCallback(
    (
      point: Point,
      ignoreNodeId: string,
      radius: number
    ): { nodeId: string; portIndex: number } | null => {
      let closest: { nodeId: string; portIndex: number; distance: number } | null = null;

      for (const node of nodes) {
        if (node.id === ignoreNodeId) continue;

        const ports = getNodePortPoints(node);
        for (const port of ports) {
          const distance = Math.hypot(point.x - port.x, point.y - port.y);
          if (distance < radius && (!closest || distance < closest.distance)) {
            closest = { nodeId: node.id, portIndex: port.index, distance };
          }
        }
      }

      return closest ? { nodeId: closest.nodeId, portIndex: closest.portIndex } : null;
    },
    [nodes]
  );

  const handlePortDragEnd = useCallback((finalPoint: Point) => {
    if (!edgeDrag || !run) {
      console.debug('[graph] edge drag end: no active drag or run', {
        hasEdgeDrag: !!edgeDrag,
        hasRun: !!run
      });
      endEdgeDrag();
      return;
    }

    // Use the final point passed from the gesture handler to avoid race condition
    // The store's edgeDrag.currentPoint may be stale due to async runOnJS updates
    const dropPoint = finalPoint;

    console.debug('[graph] edge drag end', {
      fromNodeId: edgeDrag.fromNodeId,
      fromPortIndex: edgeDrag.fromPortIndex,
      finalPoint: dropPoint,
      storePoint: edgeDrag.currentPoint,
    });

    const zoom = Math.max(viewportZoom.value || 1, 0.1);
    const snapRadius = EDGE_SNAP_RADIUS / zoom;
    let target = findClosestPort(dropPoint, edgeDrag.fromNodeId, snapRadius);

    if (!target) {
      const hitNode = findNodeAtPoint(dropPoint, nodes, edgeDrag.fromNodeId);
      if (hitNode) {
        target = findClosestPortOnNode(hitNode, dropPoint);
        console.debug('[graph] edge drop: found node fallback', {
          nodeId: hitNode.id,
          targetPort: target
        });
      }
    }

    if (!target) {
      // Log all available target ports for debugging
      const availablePorts: Array<{ nodeId: string; label: string; ports: Array<{ index: number; x: number; y: number; distance: number }> }> = [];
      for (const node of nodes) {
        if (node.id === edgeDrag.fromNodeId) continue;
        const ports = getNodePortPoints(node);
        const portsWithDistance = ports.map(p => ({
          index: p.index,
          x: p.x,
          y: p.y,
          distance: Math.hypot(dropPoint.x - p.x, dropPoint.y - p.y)
        }));
        availablePorts.push({
          nodeId: node.id.slice(0, 8),
          label: node.label,
          ports: portsWithDistance
        });
      }
      console.debug('[graph] edge drop: no target found', {
        fromNodeId: edgeDrag.fromNodeId.slice(0, 8),
        dropPoint,
        snapRadius,
        availablePorts,
      });
    }

    if (target) {
      console.debug('[graph] edge drop: found target', {
        fromNodeId: edgeDrag.fromNodeId,
        targetNodeId: target.nodeId,
        targetPortIndex: target.portIndex,
      });

      // Check if edge already exists
      const edgeExists = edges.some(
        (e) =>
          (e.from === edgeDrag.fromNodeId && e.to === target.nodeId) ||
          (e.bidirectional && e.from === target.nodeId && e.to === edgeDrag.fromNodeId)
      );

      if (edgeExists) {
        console.debug('[graph] edge already exists, skipping creation');
      } else {
        const newEdge = {
          id: createUuid(),
          from: edgeDrag.fromNodeId,
          to: target.nodeId,
          bidirectional: true,
          type: 'handoff' as const,
          label: '',
        };

        console.debug('[graph] creating new edge', newEdge);

        // Create edge via API
        api
          .createEdge(run.id, newEdge)
          .then((created) => {
            console.debug('[graph] edge created successfully', { id: created.id });
            addEdge(created);
          })
          .catch((err) => {
            console.error('[graph] failed to create edge:', err);
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            Alert.alert(
              'Edge Creation Failed',
              `Could not create connection between nodes: ${errorMessage}`,
              [{ text: 'OK' }]
            );
          });
      }
    }

    // Clear shared values for preview
    edgeDragActive.value = false;
    edgeDragFromNodeId.value = null;
    endEdgeDrag();
  }, [edgeDrag, run, edges, findClosestPort, addEdge, endEdgeDrag, nodes, viewportZoom]);

  // Edge preview path using derived value for smooth Skia rendering
  const edgePreviewSkiaPath = useDerivedValue(() => {
    const path = Skia.Path.Make();

    if (!edgeDragActive.value || !edgeDragFromNodeId.value) {
      return path;
    }

    const sourceNodeData = sharedNodes.value[edgeDragFromNodeId.value];
    if (!sourceNodeData) {
      return path;
    }

    const { position, dimensions } = sourceNodeData;
    const portIndex = edgeDragFromPortIndex.value;

    // Calculate port positions based on index
    let startX: number;
    let startY: number;

    switch (portIndex) {
      case 0: // top
        startX = position.x + dimensions.width / 2;
        startY = position.y;
        break;
      case 1: // right
        startX = position.x + dimensions.width;
        startY = position.y + dimensions.height / 2;
        break;
      case 2: // bottom
        startX = position.x + dimensions.width / 2;
        startY = position.y + dimensions.height;
        break;
      case 3: // left
        startX = position.x;
        startY = position.y + dimensions.height / 2;
        break;
      default:
        startX = position.x + dimensions.width / 2;
        startY = position.y;
    }

    path.moveTo(startX, startY);
    path.lineTo(edgeDragCurrentX.value, edgeDragCurrentY.value);
    return path;
  }, []);


  // Calculate handoff packet positions for active animations
  const handoffPackets = useMemo(() => {
    const packets: Array<{ id: string; x: number; y: number }> = [];

    for (const handoff of recentHandoffs) {
      const elapsed = animationTime - Date.parse(handoff.createdAt);
      if (elapsed < 0 || elapsed >= HANDOFF_ANIMATION_DURATION_MS) continue;

      const progress = elapsed / HANDOFF_ANIMATION_DURATION_MS;

      // Find source and target nodes
      const sourceNode = nodes.find((n) => n.id === handoff.fromNodeId);
      const targetNode = nodes.find((n) => n.id === handoff.toNodeId);
      if (!sourceNode || !targetNode) continue;

      // Calculate position along the Bezier curve
      const pos = getBezierPoint(
        { position: sourceNode.position, dimensions: sourceNode.dimensions },
        { position: targetNode.position, dimensions: targetNode.dimensions },
        progress
      );
      packets.push({ id: handoff.id, x: pos.x, y: pos.y });
    }

    return packets;
  }, [recentHandoffs, nodes, animationTime]);

  const nodesTransformStyle = useAnimatedStyle(
    () => {
      return {
        transform: [
          { translateX: viewportX.value },
          { translateY: viewportY.value },
          { scale: viewportZoom.value },
        ],
        transformOrigin: 'top left',
      };
    },
    []
  );

  const groupTransform = useDerivedValue(() => {
    const m = Skia.Matrix();
    m.translate(viewportX.value, viewportY.value);
    m.scale(viewportZoom.value, viewportZoom.value);
    return m;
  });

  return (
    <View ref={containerRef} style={styles.container} onLayout={onLayout}>
      <View style={styles.canvasContainer}>
        <GestureDetector gesture={composedGesture}>
          {/* We wrap everything in a view to ensure gestures are captured over the entire area, including nodes */}
          <View style={{ flex: 1 }}>
            <View style={styles.gestureLayer}>
              {/* Skia canvas for edges */}
              <Canvas style={[styles.canvas, { width: dimensions.width, height: dimensions.height }]}>
                <Group
                  matrix={groupTransform}
                >
                  {edges.map((edge) => (
                    <AnimatedEdge
                      key={edge.id}
                      edge={edge}
                      sharedNodes={sharedNodes}
                    />
                  ))}

                  {/* Edge preview while dragging */}
                  <Path
                    path={edgePreviewSkiaPath}
                    color={colors.accent}
                    style="stroke"
                    strokeWidth={3}
                    strokeCap="round"
                  />

                  {/* Handoff animation packets */}
                  {handoffPackets.map((packet) => (
                    <Group key={packet.id}>
                      {/* Outer glow */}
                      <Circle cx={packet.x} cy={packet.y} r={8} color="#4287f5" opacity={0.4} />
                      {/* Inner core */}
                      <Circle cx={packet.x} cy={packet.y} r={4} color="#ffffff" />
                    </Group>
                  ))}
                </Group>
              </Canvas>
            </View>

            {/* Native views for nodes */}
            <Animated.View
              pointerEvents="box-none"
              style={[styles.nodesContainer, nodesTransformStyle]}
            >
              {/* Node cards */}
              {nodes.map((node) => (
                <NodeCard
                  key={node.id}
                  node={node}
                  mode={mode}
                  viewportX={viewportX}
                  viewportY={viewportY}
                  viewportZoom={viewportZoom}
                  canvasOffset={canvasOffset}
                  onPress={selectNode}
                  onLongPress={handleNodeLongPress}
                  onDelete={handleDeleteNode}
                  onDrag={updateNodePosition}
                  onPortDragStart={handlePortDragStart}
                  onPortDragMove={handlePortDragMove}
                  onPortDragEnd={handlePortDragEnd}
                  sharedNodes={sharedNodes}
                  activeDragNodeId={activeDragNodeId}
                  onCanvasGestureStart={cancelMomentumForNode}
                  graphPinchGesture={pinchGesture}
                  isPinching={isPinching}
                />
              ))}
            </Animated.View>
          </View>
        </GestureDetector>
        
        {/* Toolbar Overlay */}
        <GraphToolbar mode={mode} onChange={setMode} panelHeight={controlsPanelHeight} />
      </View>
    </View>
  );
}

// Minimal subsets for worklets to avoid serializing full VisualNode
type NodeLayout = {
  position: { x: number; y: number };
  dimensions: { width: number; height: number };
};

type ViewDimensions = { width: number; height: number };

type Port = { x: number; y: number; normal: { x: number; y: number } };

function getNodePorts(layout: NodeLayout): Port[] {
  'worklet';
  const { x, y } = layout.position;
  const { width, height } = layout.dimensions;
  return [
    { x: x + width / 2, y, normal: { x: 0, y: -1 } },          // Top
    { x: x + width, y: y + height / 2, normal: { x: 1, y: 0 } }, // Right
    { x: x + width / 2, y: y + height, normal: { x: 0, y: 1 } }, // Bottom
    { x, y: y + height / 2, normal: { x: -1, y: 0 } }          // Left
  ];
}

function getNodePortPoints(node: VisualNode): Array<{ index: number; x: number; y: number }> {
  return [
    { index: 0, x: node.position.x + node.dimensions.width / 2, y: node.position.y }, // top
    { index: 1, x: node.position.x + node.dimensions.width, y: node.position.y + node.dimensions.height / 2 }, // right
    { index: 2, x: node.position.x + node.dimensions.width / 2, y: node.position.y + node.dimensions.height }, // bottom
    { index: 3, x: node.position.x, y: node.position.y + node.dimensions.height / 2 }, // left
  ];
}

function findNodeAtPoint(
  point: Point,
  nodes: VisualNode[],
  ignoreNodeId: string
): VisualNode | null {
  for (const node of nodes) {
    if (node.id === ignoreNodeId) continue;
    const { x, y } = node.position;
    if (
      point.x >= x &&
      point.x <= x + node.dimensions.width &&
      point.y >= y &&
      point.y <= y + node.dimensions.height
    ) {
      return node;
    }
  }
  return null;
}

function findClosestPortOnNode(
  node: VisualNode,
  point: Point
): { nodeId: string; portIndex: number } {
  const ports = getNodePortPoints(node);
  let closest = ports[0]!;
  let closestDistance = Infinity;
  for (const port of ports) {
    const distance = Math.hypot(point.x - port.x, point.y - port.y);
    if (distance < closestDistance) {
      closest = port;
      closestDistance = distance;
    }
  }
  return { nodeId: node.id, portIndex: closest.index };
}

function getEdgeGeometry(source: NodeLayout, target: NodeLayout) {
  'worklet';
  const sourcePorts = getNodePorts(source);
  const targetPorts = getNodePorts(target);

  // Find shortest connection
  let minDist = Infinity;
  let start = sourcePorts[0]!;
  let end = targetPorts[0]!;

  for (const sp of sourcePorts) {
    for (const tp of targetPorts) {
      const d = Math.hypot(tp.x - sp.x, tp.y - sp.y);
      if (d < minDist) {
        minDist = d;
        start = sp;
        end = tp;
      }
    }
  }

  const dist = minDist;
  // Control point offset based on distance, clamped like web
  const offset = Math.min(dist * 0.5, 150);

  const cp1 = {
    x: start.x + start.normal.x * offset,
    y: start.y + start.normal.y * offset
  };
  
  const cp2 = {
    x: end.x + end.normal.x * offset,
    y: end.y + end.normal.y * offset
  };

  return { start, end, cp1, cp2 };
}

function createEdgePath(source: NodeLayout, target: NodeLayout) {
  'worklet';
  const path = Skia.Path.Make();
  const { start, end, cp1, cp2 } = getEdgeGeometry(source, target);

  path.moveTo(start.x, start.y);
  path.cubicTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
  return path;
}

// Cubic Bezier interpolation
function bezier(t: number, p0: number, p1: number, p2: number, p3: number) {
  'worklet';
  const mt = 1 - t;
  return mt * mt * mt * p0 + 
         3 * mt * mt * t * p1 + 
         3 * mt * t * t * p2 + 
         t * t * t * p3;
}

// Calculate position on cubic Bezier curve at parameter t (0-1)
function getBezierPoint(
  source: NodeLayout,
  target: NodeLayout,
  t: number
): { x: number; y: number } {
  'worklet';
  const { start, end, cp1, cp2 } = getEdgeGeometry(source, target);

  return {
    x: bezier(t, start.x, cp1.x, cp2.x, end.x),
    y: bezier(t, start.y, cp1.y, cp2.y, end.y),
  };
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq;
  const clamped = Math.max(0, Math.min(1, t));
  const projX = start.x + clamped * dx;
  const projY = start.y + clamped * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

function getEdgeDistanceToPoint(
  point: Point,
  source: NodeLayout,
  target: NodeLayout,
  samples: number
): number {
  const { start, end, cp1, cp2 } = getEdgeGeometry(source, target);
  const steps = Math.max(6, samples);
  let minDistance = Infinity;
  let prev = { x: start.x, y: start.y };

  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const curr = {
      x: bezier(t, start.x, cp1.x, cp2.x, end.x),
      y: bezier(t, start.y, cp1.y, cp2.y, end.y),
    };
    const distance = distanceToSegment(point, prev, curr);
    if (distance < minDistance) {
      minDistance = distance;
    }
    prev = curr;
  }

  return minDistance;
}

function findEdgeNearPoint(
  point: Point,
  edges: VisualEdge[],
  nodesById: Record<string, VisualNode>,
  hitRadius: number
): VisualEdge | null {
  let closestEdge: VisualEdge | null = null;
  let closestDistance = Infinity;

  for (const edge of edges) {
    const sourceNode = nodesById[edge.from];
    const targetNode = nodesById[edge.to];
    if (!sourceNode || !targetNode) continue;

    const distance = getEdgeDistanceToPoint(
      point,
      { position: sourceNode.position, dimensions: sourceNode.dimensions },
      { position: targetNode.position, dimensions: targetNode.dimensions },
      EDGE_HIT_SAMPLES
    );

    if (distance <= hitRadius && distance < closestDistance) {
      closestDistance = distance;
      closestEdge = edge;
    }
  }

  return closestEdge;
}



interface AnimatedEdgeProps {
  edge: VisualEdge;
  sharedNodes: SharedValue<Record<string, { position: Point; dimensions: ViewDimensions }>>;
}

function AnimatedEdge({ edge, sharedNodes }: AnimatedEdgeProps) {
  const edgePath = useDerivedValue(() => {
    const source = sharedNodes.value[edge.from];
    const target = sharedNodes.value[edge.to];
    if (!source || !target) {
      return Skia.Path.Make();
    }
    return createEdgePath(source, target);
  }, [edge]);

  const arrowPath = useDerivedValue(() => {
    const source = sharedNodes.value[edge.from];
    const target = sharedNodes.value[edge.to];
    if (!source || !target) {
      return Skia.Path.Make();
    }

    const { start, end, cp1, cp2 } = getEdgeGeometry(source, target);
    const path = Skia.Path.Make();
    const arrowLength = 10;
    const arrowWidth = 4;

    const addArrow = (tip: { x: number; y: number }, tail: { x: number; y: number }) => {
      const dx = tip.x - tail.x;
      const dy = tip.y - tail.y;
      const angle = Math.atan2(dy, dx);

      path.moveTo(tip.x, tip.y);
      path.lineTo(
        tip.x - arrowLength * Math.cos(angle) + arrowWidth * Math.sin(angle),
        tip.y - arrowLength * Math.sin(angle) - arrowWidth * Math.cos(angle)
      );
      path.lineTo(
        tip.x - arrowLength * Math.cos(angle) - arrowWidth * Math.sin(angle),
        tip.y - arrowLength * Math.sin(angle) + arrowWidth * Math.cos(angle)
      );
      path.close();
    };

    // End Arrow (points from cp2 to end)
    addArrow(end, cp2);

    // Start Arrow (if bidirectional, points from cp1 to start)
    if (edge.bidirectional) {
      addArrow(start, cp1);
    }

    return path;
  }, [edge]);

  const color = edge.selected ? colors.accent : colors.borderStrong;

  return (
    <Group>
      <Path
        path={edgePath}
        color={color}
        style="stroke"
        strokeWidth={edge.selected ? 3 : 2}
        strokeCap="round"
      />
      <Path
        path={arrowPath}
        color={color}
        style="fill"
      />
    </Group>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  fallback: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing['3xl'],
  },
  fallbackTitle: {
    color: colors.textPrimary,
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.lg,
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  fallbackText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
  },
  canvasContainer: {
    flex: 1,
  },
  gestureLayer: {
    flex: 1,
  },
  canvas: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  nodesContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  toolbarWrapper: {
    position: 'absolute',
    right: 16,
    zIndex: 100,
  },
  toolbarContainer: {
    flexDirection: 'row',
    borderRadius: radius.full,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  toolbarBlur: {
    borderRadius: radius.full,
  },
  toolbarOverlay: {
    backgroundColor: colors.glassBg,
    borderRadius: radius.full,
  },
  toolbarHighlight: {
    position: 'absolute',
    top: 0,
    left: spacing.md,
    right: spacing.md,
    height: 1,
    backgroundColor: colors.glassHighlight,
    zIndex: 3,
  },
  toolbarContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: TOOLBAR_PADDING,
    gap: TOOLBAR_GAP,
    zIndex: 1,
  },
  liquidIndicator: {
    position: 'absolute',
    left: TOOLBAR_PADDING,
    top: TOOLBAR_PADDING,
    width: TOOLBAR_ICON_SIZE,
    height: TOOLBAR_ICON_SIZE,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    overflow: 'hidden',
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  liquidIndicatorShimmer: {
    position: 'absolute',
    top: 0,
    left: '15%',
    right: '15%',
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
  toolbarIconBtn: {
    width: TOOLBAR_ICON_SIZE,
    height: TOOLBAR_ICON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  toolbarLabel: {
    marginTop: spacing.sm,
    textAlign: 'center',
    fontSize: fontSize.xs,
    fontFamily: fontFamily.medium,
    color: colors.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
});
