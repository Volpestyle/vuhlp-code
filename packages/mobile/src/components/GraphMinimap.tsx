import { useMemo, useEffect, useCallback } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { Canvas, Rect, RoundedRect } from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, useDerivedValue, SharedValue, useSharedValue } from 'react-native-reanimated';
import { useGraphStore } from '@/stores/graph-store';
import { colors } from '@/lib/theme';
import {
  MINIMAP_PADDING,
  MINIMAP_PADDING_RATIO,
  getMinimapBounds,
  getMinimapTransform,
  type MinimapBounds,
  type MinimapTransform,
  type MinimapSize,
} from '@vuhlp/shared';

interface GraphMinimapProps {
  width?: number;
  height?: number;
  viewportX: SharedValue<number>;
  viewportY: SharedValue<number>;
  viewportZoom: SharedValue<number>;
  gestureActive?: SharedValue<boolean>;
}

export function GraphMinimap({ 
  width = 150, 
  height = 100,
  viewportX,
  viewportY,
  viewportZoom,
  gestureActive,
}: GraphMinimapProps) {
  const screenDimensions = useWindowDimensions();
  const nodes = useGraphStore((s) => s.nodes);
  const viewDimensions = useGraphStore((s) => s.viewDimensions);
  const setViewport = useGraphStore((s) => s.setViewport);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);

  // Calculate the bounding box of all nodes with padding
  const bounds = useMemo(
    () =>
      getMinimapBounds(nodes, {
        padding: MINIMAP_PADDING,
        paddingRatio: MINIMAP_PADDING_RATIO,
      }),
    [nodes]
  );

  // Calculate transform for rendering
  const transform = useMemo(() => {
    if (!bounds) return null;
    return getMinimapTransform(bounds, { width, height });
  }, [bounds, width, height]);

  // Shared values for worklet access
  const boundsSV = useSharedValue<MinimapBounds | null>(bounds);
  const transformSV = useSharedValue<MinimapTransform | null>(transform);
  const viewDimensionsSV = useSharedValue<MinimapSize>({
    width: viewDimensions.width || screenDimensions.width,
    height: viewDimensions.height || screenDimensions.height,
  });

  // Sync shared values when JS state changes
  useEffect(() => {
    boundsSV.value = bounds;
  }, [bounds, boundsSV]);

  useEffect(() => {
    transformSV.value = transform;
  }, [transform, transformSV]);

  useEffect(() => {
    viewDimensionsSV.value = {
      width: viewDimensions.width || screenDimensions.width,
      height: viewDimensions.height || screenDimensions.height,
    };
  }, [viewDimensions, screenDimensions, viewDimensionsSV]);

  // Sync back to store after gesture ends
  const syncViewportToStore = useCallback(() => {
    setViewport({
      x: viewportX.value,
      y: viewportY.value,
      zoom: viewportZoom.value,
    });
  }, [setViewport, viewportX, viewportY, viewportZoom]);

  // Pan gesture for drag navigation - runs on UI thread
  const panGesture = Gesture.Pan()
    .onBegin(() => {
      'worklet';
      if (gestureActive) {
        gestureActive.value = true;
      }
    })
    .onUpdate((e) => {
      'worklet';
      const b = boundsSV.value;
      const t = transformSV.value;
      const vd = viewDimensionsSV.value;

      if (!b || !t) return;

      // Inline getMinimapWorldPoint logic to avoid bridge/import issues
      const worldX = (e.x - t.offsetX) / t.scale + b.minX;
      const worldY = (e.y - t.offsetY) / t.scale + b.minY;

      // Inline getViewportForWorldCenter logic
      const z = viewportZoom.value || 1;
      const nextVx = vd.width / 2 - worldX * z;
      const nextVy = vd.height / 2 - worldY * z;

      viewportX.value = nextVx;
      viewportY.value = nextVy;
    })
    .onEnd(() => {
      runOnJS(syncViewportToStore)();
    })
    .onFinalize(() => {
      'worklet';
      if (gestureActive) {
        gestureActive.value = false;
      }
    });

  // Tap gesture for quick navigation - also uses worklet logic for consistency
  const tapGesture = Gesture.Tap()
    .onBegin(() => {
      'worklet';
      if (gestureActive) {
        gestureActive.value = true;
      }
    })
    .onEnd((e) => {
      'worklet';
      const b = boundsSV.value;
      const t = transformSV.value;
      const vd = viewDimensionsSV.value;

      if (!b || !t) return;

      const worldX = (e.x - t.offsetX) / t.scale + b.minX;
      const worldY = (e.y - t.offsetY) / t.scale + b.minY;

      const z = viewportZoom.value || 1;
      const nextVx = vd.width / 2 - worldX * z;
      const nextVy = vd.height / 2 - worldY * z;

      viewportX.value = nextVx;
      viewportY.value = nextVy;
      
      runOnJS(syncViewportToStore)();
    })
    .onFinalize(() => {
      'worklet';
      if (gestureActive) {
        gestureActive.value = false;
      }
    });

  const composedGesture = Gesture.Simultaneous(panGesture, tapGesture);

  // Calculate visible viewport rectangle in minimap coords (derived value for smooth updates)
  const rectX = useDerivedValue(() => {
    const b = boundsSV.value;
    const t = transformSV.value;
    if (!b || !t) return 0;
    
    const currentZoom = viewportZoom.value || 1;
    const viewWorldLeft = -viewportX.value / currentZoom;
    return (viewWorldLeft - b.minX) * t.scale + t.offsetX;
  }, [boundsSV, transformSV, viewportX, viewportY, viewportZoom]);

  const rectY = useDerivedValue(() => {
    const b = boundsSV.value;
    const t = transformSV.value;
    if (!b || !t) return 0;

    const currentZoom = viewportZoom.value || 1;
    const viewWorldTop = -viewportY.value / currentZoom;
    return (viewWorldTop - b.minY) * t.scale + t.offsetY;
  }, [boundsSV, transformSV, viewportX, viewportY, viewportZoom]);

  const rectWidth = useDerivedValue(() => {
    const b = boundsSV.value;
    const t = transformSV.value;
    const vd = viewDimensionsSV.value;
    if (!b || !t) return 0;

    const currentZoom = viewportZoom.value || 1;
    const viewWorldRight = (vd.width - viewportX.value) / currentZoom;
    const viewWorldLeft = -viewportX.value / currentZoom;
    return (viewWorldRight - viewWorldLeft) * t.scale;
  }, [boundsSV, transformSV, viewDimensionsSV, viewportX, viewportY, viewportZoom]);

  const rectHeight = useDerivedValue(() => {
    const b = boundsSV.value;
    const t = transformSV.value;
    const vd = viewDimensionsSV.value;
    if (!b || !t) return 0;

    const currentZoom = viewportZoom.value || 1;
    const viewWorldBottom = (vd.height - viewportY.value) / currentZoom;
    const viewWorldTop = -viewportY.value / currentZoom;
    return (viewWorldBottom - viewWorldTop) * t.scale;
  }, [boundsSV, transformSV, viewDimensionsSV, viewportX, viewportY, viewportZoom]);

  if (!bounds || !transform) {
    return null;
  }

  return (
    <View style={[styles.container, { width, height }]}>
      <GestureDetector gesture={composedGesture}>
        <Canvas style={styles.canvas}>
          {/* Render nodes as small rectangles */}
          {nodes.map((node) => {
            const x = (node.position.x - bounds.minX) * transform.scale + transform.offsetX;
            const y = (node.position.y - bounds.minY) * transform.scale + transform.offsetY;
            const w = Math.max(2, node.dimensions.width * transform.scale);
            const h = Math.max(2, node.dimensions.height * transform.scale);
            const isActive = node.id === selectedNodeId;

            return (
              <RoundedRect
                key={node.id}
                x={x}
                y={y}
                width={w}
                height={h}
                r={1}
                color={isActive ? colors.accent : colors.textMuted}
              />
            );
          })}

          {/* Render viewport rectangle */}
          <Rect
            x={rectX}
            y={rectY}
            width={rectWidth}
            height={rectHeight}
            color={colors.accentGlow}
          />
          <Rect
            x={rectX}
            y={rectY}
            width={rectWidth}
            height={rectHeight}
            color={colors.accent}
            style="stroke"
            strokeWidth={1}
          />
        </Canvas>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(24, 24, 28, 0.95)', // colors.bgSurface with opacity
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    overflow: 'hidden',
  },
  canvas: {
    flex: 1,
  },
});
