import { useState, useCallback, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, useWindowDimensions, LayoutChangeEvent, Alert } from 'react-native';
import { Canvas, Path, Skia, Group, Line, vec } from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
  useDerivedValue,
} from 'react-native-reanimated';
import {
  useGraphStore,
  type VisualNode,
  type VisualEdge,
  type Point,
} from '@/stores/graph-store';
import { api } from '@/lib/api';
import { NodeCard } from './NodeCard';
import { colors, fontFamily, fontSize, spacing } from '@/lib/theme';
import { createUuid } from '@/lib/ids';

const SPRING_CONFIG = {
  damping: 20,
  stiffness: 200,
};

const EDGE_SNAP_RADIUS = 30;

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

export function GraphCanvas() {
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

  return <SkiaGraphCanvas />;
}

function SkiaGraphCanvas() {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [dimensions, setDimensions] = useState({ width: windowWidth, height: windowHeight });

  const run = useGraphStore((s) => s.run);
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const viewport = useGraphStore((s) => s.viewport);
  const edgeDrag = useGraphStore((s) => s.edgeDrag);
  const setViewport = useGraphStore((s) => s.setViewport);
  const setViewDimensions = useGraphStore((s) => s.setViewDimensions);
  const selectNode = useGraphStore((s) => s.selectNode);
  const setInspectorOpen = useGraphStore((s) => s.setInspectorOpen);
  const updateNodePosition = useGraphStore((s) => s.updateNodePosition);
  const startEdgeDrag = useGraphStore((s) => s.startEdgeDrag);
  const updateEdgeDrag = useGraphStore((s) => s.updateEdgeDrag);
  const endEdgeDrag = useGraphStore((s) => s.endEdgeDrag);
  const addEdge = useGraphStore((s) => s.addEdge);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setDimensions({ width, height });
      setViewDimensions({ width, height });
    },
    [setViewDimensions]
  );

  // Animated viewport values for smooth gestures
  const viewportX = useSharedValue(viewport.x);
  const viewportY = useSharedValue(viewport.y);
  const viewportZoom = useSharedValue(viewport.zoom);

  // Sync shared values from store (gesture math relies on the latest values)
  // We only sync if no gesture is active to avoid fighting with the UI thread
  const isGestureActive = useSharedValue(false);
  const isPinching = useSharedValue(false);
  const isPanning = useSharedValue(false);
  const panRebasePending = useSharedValue(false);

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
  const syncFrameCount = useSharedValue(0);
  const lastPinchPointerCount = useSharedValue(0);
  const panTranslationOffsetX = useSharedValue(0);
  const panTranslationOffsetY = useSharedValue(0);
  const lastPanTranslationX = useSharedValue(0);

  const lastPanTranslationY = useSharedValue(0);

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

  const syncViewport = useCallback(() => {
    setViewport({
      x: viewportX.value,
      y: viewportY.value,
      zoom: viewportZoom.value,
    });
  }, [setViewport, viewportX, viewportY, viewportZoom]);

  const syncViewportFrame = useCallback(
    (x: number, y: number, zoom: number) => {
      setViewport({ x, y, zoom });
    },
    [setViewport]
  );

  // Pinch gesture - always active, works simultaneously with other gestures
  const pinchGesture = Gesture.Pinch()
    .onStart((e) => {
      isGestureActive.value = true;
      isPinching.value = true;
      panRebasePending.value = false;
      savedZoom.value = viewportZoom.value;
      const zoom = viewportZoom.value || 1;
      pinchWorldX.value = (e.focalX - viewportX.value) / zoom;
      pinchWorldY.value = (e.focalY - viewportY.value) / zoom;
      syncFrameCount.value = 0;
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
      syncFrameCount.value += 1;
      if (syncFrameCount.value % 3 === 0) {
        runOnJS(syncViewportFrame)(
          viewportX.value,
          viewportY.value,
          viewportZoom.value
        );
      }
    })
    .onEnd(() => {
      isPinching.value = false;
      lastPinchPointerCount.value = 0;
      panRebasePending.value = true;
      if (isPanning.value) {
        savedX.value = viewportX.value;
        savedY.value = viewportY.value;
        syncFrameCount.value = 0;
      }
      isGestureActive.value = isPanning.value;
      runOnJS(syncViewport)();
    })
    .onFinalize(() => {
      isPinching.value = false;
      lastPinchPointerCount.value = 0;
      isGestureActive.value = isPanning.value;
    });

  // Pan gesture - single finger allowed now
  const panGesture = Gesture.Pan()
    .maxPointers(1)
    .onStart((e) => {
      isGestureActive.value = true;
      isPanning.value = true;
      savedX.value = viewportX.value;
      savedY.value = viewportY.value;
      panTranslationOffsetX.value = e.translationX;
      panTranslationOffsetY.value = e.translationY;
      lastPanTranslationX.value = e.translationX;
      lastPanTranslationY.value = e.translationY;
      syncFrameCount.value = 0;
    })
    .onUpdate((e) => {
      lastPanTranslationX.value = e.translationX;
      lastPanTranslationY.value = e.translationY;
      if (panRebasePending.value) {
        savedX.value = viewportX.value;
        savedY.value = viewportY.value;
        panTranslationOffsetX.value = e.translationX;
        panTranslationOffsetY.value = e.translationY;
        panRebasePending.value = false;
        syncFrameCount.value = 0;
        return;
      }
      if (isPinching.value) {
        return;
      }
      const nextX = savedX.value + (e.translationX - panTranslationOffsetX.value);
      const nextY = savedY.value + (e.translationY - panTranslationOffsetY.value);
      viewportX.value = nextX;
      viewportY.value = nextY;
      syncFrameCount.value += 1;
      if (syncFrameCount.value % 3 === 0) {
        runOnJS(syncViewportFrame)(
          viewportX.value,
          viewportY.value,
          viewportZoom.value
        );
      }
    })
    .onEnd(() => {
      isPanning.value = false;
      isGestureActive.value = isPinching.value;
      runOnJS(syncViewport)();
    })
    .onFinalize(() => {
      isPanning.value = false;
      isGestureActive.value = isPinching.value;
    });

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
    (worldX: number, worldY: number) => {
      const hitNode = nodes.some((node) => {
        const { x, y } = node.position;
        return (
          worldX >= x &&
          worldX <= x + node.dimensions.width &&
          worldY >= y &&
          worldY <= y + node.dimensions.height
        );
      });

      if (!hitNode) {
        selectNode(null);
      }
    },
    [nodes, selectNode]
  );
  
  // Consolidated tap handler for both single and double taps
  // We manually detect double taps to ensure they are close together spatially
  const tapGesture = Gesture.Tap()
    .maxDuration(250)
    .onEnd((event) => {
      if (isPanning.value || isPinching.value) return;

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
        runOnJS(handleCanvasTap)(worldX, worldY);

        // Record this tap for potential double tap
        lastTapTime.value = now;
        lastTapX.value = event.x;
        lastTapY.value = event.y;
      }
    });

  // Compose gestures:
  // - Pinch always works (simultaneous with pan for two-finger navigation)
  // - Pan is exclusive with tap gestures (dragging won't trigger tap)
  const composedGesture = Gesture.Simultaneous(
    pinchGesture,
    Gesture.Exclusive(panGesture, tapGesture)
  );

  // Port drag handlers
  const handlePortDragStart = useCallback(
    (nodeId: string, portIndex: number, point: Point) => {
      startEdgeDrag(nodeId, portIndex, point);
    },
    [startEdgeDrag]
  );

  const handlePortDragMove = useCallback(
    (point: Point) => {
      updateEdgeDrag(point);
    },
    [updateEdgeDrag]
  );

  // Find closest port to a point
  const findClosestPort = useCallback(
    (point: Point, ignoreNodeId: string): { nodeId: string; portIndex: number } | null => {
      let closest: { nodeId: string; portIndex: number; distance: number } | null = null;

      for (const node of nodes) {
        if (node.id === ignoreNodeId) continue;

        const ports = [
          { x: node.position.x + node.dimensions.width / 2, y: node.position.y, index: 0 },
          { x: node.position.x + node.dimensions.width, y: node.position.y + node.dimensions.height / 2, index: 1 },
          { x: node.position.x + node.dimensions.width / 2, y: node.position.y + node.dimensions.height, index: 2 },
          { x: node.position.x, y: node.position.y + node.dimensions.height / 2, index: 3 },
        ];

        for (const port of ports) {
          const distance = Math.hypot(point.x - port.x, point.y - port.y);
          if (distance < EDGE_SNAP_RADIUS && (!closest || distance < closest.distance)) {
            closest = { nodeId: node.id, portIndex: port.index, distance };
          }
        }
      }

      return closest;
    },
    [nodes]
  );

  // Focus on a specific node (expand/maximize)
  const focusNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      runOnJS(selectNode)(nodeId);

      // Animation targets
      const padding = 40;
      const contentWidth = node.dimensions.width + padding * 2;
      const contentHeight = node.dimensions.height + padding * 2;
      
      const scaleX = dimensions.width / contentWidth;
      const scaleY = dimensions.height / contentHeight;
      // Cap zoom at 1.5x or fit-to-screen
      const targetZoom = Math.min(scaleX, scaleY, 1.5);

      const contentCenterX = node.position.x + node.dimensions.width / 2;
      const contentCenterY = node.position.y + node.dimensions.height / 2;

      const targetVx = dimensions.width / 2 - contentCenterX * targetZoom;
      const targetVy = dimensions.height / 2 - contentCenterY * targetZoom;

      isGestureActive.value = true;
      viewportX.value = withSpring(targetVx, SPRING_CONFIG);
      viewportY.value = withSpring(targetVy, SPRING_CONFIG);
      viewportZoom.value = withSpring(targetZoom, SPRING_CONFIG, (finished) => {
        if (finished) {
          isGestureActive.value = false;
          runOnJS(syncViewport)();
        }
      });
    },
    [nodes, dimensions, selectNode, viewportX, viewportY, viewportZoom, isGestureActive, syncViewport]
  );

  const handlePortDragEnd = useCallback(() => {
    if (!edgeDrag || !run) {
      endEdgeDrag();
      return;
    }

    const target = findClosestPort(edgeDrag.currentPoint, edgeDrag.fromNodeId);

    if (target) {
      // Check if edge already exists
      const edgeExists = edges.some(
        (e) =>
          (e.from === edgeDrag.fromNodeId && e.to === target.nodeId) ||
          (e.bidirectional && e.from === target.nodeId && e.to === edgeDrag.fromNodeId)
      );

      if (!edgeExists) {
        const newEdge = {
          id: createUuid(),
          from: edgeDrag.fromNodeId,
          to: target.nodeId,
          bidirectional: true,
          type: 'handoff' as const,
          label: '',
        };

        // Create edge via API
        api
          .createEdge(run.id, newEdge)
          .then((created) => addEdge(created))
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

    endEdgeDrag();
  }, [edgeDrag, run, edges, findClosestPort, addEdge, endEdgeDrag]);

  // Build Skia paths for edges
  const edgePaths = useMemo(() => {
    return edges
      .map((edge) => {
        const source = nodes.find((n) => n.id === edge.from);
        const target = nodes.find((n) => n.id === edge.to);
        if (!source || !target) return null;

        const path = createEdgePath(source, target);
        return { edge, path };
      })
      .filter(Boolean) as Array<{ edge: VisualEdge; path: ReturnType<typeof Skia.Path.Make> }>;
  }, [nodes, edges]);

  // Edge preview path
  const edgePreviewPath = useMemo(() => {
    if (!edgeDrag) return null;

    const sourceNode = nodes.find((n) => n.id === edgeDrag.fromNodeId);
    if (!sourceNode) return null;

    const portPositions = [
      { x: sourceNode.position.x + sourceNode.dimensions.width / 2, y: sourceNode.position.y },
      { x: sourceNode.position.x + sourceNode.dimensions.width, y: sourceNode.position.y + sourceNode.dimensions.height / 2 },
      { x: sourceNode.position.x + sourceNode.dimensions.width / 2, y: sourceNode.position.y + sourceNode.dimensions.height },
      { x: sourceNode.position.x, y: sourceNode.position.y + sourceNode.dimensions.height / 2 },
    ];

    const startPort = portPositions[edgeDrag.fromPortIndex] ?? portPositions[0];

    return {
      start: startPort,
      end: edgeDrag.currentPoint,
    };
  }, [edgeDrag, nodes]);

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
    <View style={styles.container} onLayout={onLayout}>
      <View style={styles.canvasContainer}>
        <GestureDetector gesture={composedGesture}>
          <View style={styles.gestureLayer}>
            {/* Skia canvas for edges */}
            <Canvas style={[styles.canvas, { width: dimensions.width, height: dimensions.height }]}>
              <Group
                matrix={groupTransform}
              >
                {edgePaths.map(({ edge, path }) => (
                  <Path
                    key={edge.id}
                    path={path}
                    color={edge.selected ? colors.accent : colors.borderStrong}
                    style="stroke"
                    strokeWidth={edge.selected ? 3 : 2}
                    strokeCap="round"
                  />
                ))}

                {/* Edge preview while dragging */}
                {edgePreviewPath && edgePreviewPath.start && (
                  <Line
                    p1={vec(edgePreviewPath.start.x, edgePreviewPath.start.y)}
                    p2={vec(edgePreviewPath.end.x, edgePreviewPath.end.y)}
                    color={colors.accent}
                    style="stroke"
                    strokeWidth={2}
                    strokeCap="round"
                  />
                )}
              </Group>
            </Canvas>
          </View>
        </GestureDetector>

        {/* Native views for nodes */}
        <Animated.View
          pointerEvents="box-none"
          style={[styles.nodesContainer, nodesTransformStyle]}
        >
          {nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              viewportZoom={viewport.zoom}
              onPress={selectNode}
              onDrag={updateNodePosition}
              onPortDragStart={handlePortDragStart}
              onPortDragMove={handlePortDragMove}
              onPortDragEnd={handlePortDragEnd}
              onExpand={focusNode}
            />
          ))}
        </Animated.View>
      </View>
    </View>
  );
}

function createEdgePath(source: VisualNode, target: VisualNode) {
  const path = Skia.Path.Make();

  const { startX, startY, endX, endY } = findConnectionPoints(source, target);

  const dx = endX - startX;
  const dy = endY - startY;
  const controlOffset = Math.min(Math.abs(dx), Math.abs(dy), 100) * 0.5;

  let cp1x = startX;
  let cp1y = startY;
  let cp2x = endX;
  let cp2y = endY;

  if (Math.abs(dx) > Math.abs(dy)) {
    cp1x = startX + Math.sign(dx) * controlOffset;
    cp2x = endX - Math.sign(dx) * controlOffset;
  } else {
    cp1y = startY + Math.sign(dy) * controlOffset;
    cp2y = endY - Math.sign(dy) * controlOffset;
  }

  path.moveTo(startX, startY);
  path.cubicTo(cp1x, cp1y, cp2x, cp2y, endX, endY);

  return path;
}

function findConnectionPoints(source: VisualNode, target: VisualNode) {
  const sp = source.position;
  const sd = source.dimensions;
  const tp = target.position;
  const td = target.dimensions;

  const sourcePorts = [
    { x: sp.x + sd.width / 2, y: sp.y },
    { x: sp.x + sd.width, y: sp.y + sd.height / 2 },
    { x: sp.x + sd.width / 2, y: sp.y + sd.height },
    { x: sp.x, y: sp.y + sd.height / 2 },
  ];

  const targetPorts = [
    { x: tp.x + td.width / 2, y: tp.y },
    { x: tp.x + td.width, y: tp.y + td.height / 2 },
    { x: tp.x + td.width / 2, y: tp.y + td.height },
    { x: tp.x, y: tp.y + td.height / 2 },
  ];

  let minDist = Infinity;
  let best = { startX: 0, startY: 0, endX: 0, endY: 0 };

  for (const sp of sourcePorts) {
    for (const tp of targetPorts) {
      const dist = Math.hypot(tp.x - sp.x, tp.y - sp.y);
      if (dist < minDist) {
        minDist = dist;
        best = { startX: sp.x, startY: sp.y, endX: tp.x, endY: tp.y };
      }
    }
  }

  return best;
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
});
