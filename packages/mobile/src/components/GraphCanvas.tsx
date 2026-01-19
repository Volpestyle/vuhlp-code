import { useState, useCallback, useMemo, useEffect } from 'react';
import { View, StyleSheet, useWindowDimensions, LayoutChangeEvent } from 'react-native';
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

const SPRING_CONFIG = {
  damping: 20,
  stiffness: 200,
};

const EDGE_SNAP_RADIUS = 30;

export function GraphCanvas() {
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
  useEffect(() => {
    viewportX.value = viewport.x;
    viewportY.value = viewport.y;
    viewportZoom.value = viewport.zoom;
  }, [viewport.x, viewport.y, viewport.zoom, viewportX, viewportY, viewportZoom]);

  // Track gesture state
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const savedZoom = useSharedValue(1);
  const pinchWorldX = useSharedValue(0);
  const pinchWorldY = useSharedValue(0);
  const syncFrameCount = useSharedValue(0);

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
      savedZoom.value = viewportZoom.value;
      const zoom = viewportZoom.value || 1;
      pinchWorldX.value = (e.focalX - viewportX.value) / zoom;
      pinchWorldY.value = (e.focalY - viewportY.value) / zoom;
      syncFrameCount.value = 0;
    })
    .onUpdate((e) => {
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
      runOnJS(syncViewport)();
    })
    .onFinalize(() => {
      runOnJS(syncViewport)();
    });

  // Pan gesture - single finger allowed now
  const panGesture = Gesture.Pan()
    .maxPointers(1)
    .onStart(() => {
      savedX.value = viewportX.value;
      savedY.value = viewportY.value;
      syncFrameCount.value = 0;
    })
    .onUpdate((e) => {
      const nextX = savedX.value + e.translationX;
      const nextY = savedY.value + e.translationY;
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
      runOnJS(syncViewport)();
    })
    .onFinalize(() => {
      runOnJS(syncViewport)();
    });

  // Double tap to reset view
  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      viewportX.value = withSpring(0, SPRING_CONFIG);
      viewportY.value = withSpring(0, SPRING_CONFIG);
      viewportZoom.value = withSpring(1, SPRING_CONFIG, () => {
        runOnJS(syncViewport)();
      });
    });

  // Tap to deselect
  const tapGesture = Gesture.Tap()
    .onEnd(() => {
      runOnJS(selectNode)(null);
    });

  // Compose gestures:
  // - Pinch always works (simultaneous with pan for two-finger navigation)
  // - Double-tap has priority over single-tap
  const composedGesture = Gesture.Simultaneous(
    pinchGesture,
    panGesture,
    Gesture.Exclusive(doubleTapGesture, tapGesture)
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
          id: crypto.randomUUID(),
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
          .catch((err) => console.error('[graph] failed to create edge:', err));
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

  const nodesTransformStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: viewportZoom.value },
      { translateX: viewportX.value },
      { translateY: viewportY.value },
    ],
  }));

  const groupTransform = useDerivedValue(() => [
    { scale: viewportZoom.value },
    { translateX: viewportX.value },
    { translateY: viewportY.value },
  ]);

  return (
    <View style={styles.container} onLayout={onLayout}>
      <View style={styles.canvasContainer}>
        <GestureDetector gesture={composedGesture}>
          <View style={styles.gestureLayer}>
            {/* Skia canvas for edges */}
            <Canvas style={[styles.canvas, { width: dimensions.width, height: dimensions.height }]}>
              <Group
                transform={groupTransform}
              >
                {edgePaths.map(({ edge, path }) => (
                  <Path
                    key={edge.id}
                    path={path}
                    color={edge.selected ? '#3b82f6' : '#444'}
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
                    color="#3b82f6"
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
              onPress={() => selectNode(node.id)}
              onDrag={(x, y) => updateNodePosition(node.id, x, y)}
              onPortDragStart={handlePortDragStart}
              onPortDragMove={handlePortDragMove}
              onPortDragEnd={handlePortDragEnd}
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
    backgroundColor: '#0a0a0a',
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
