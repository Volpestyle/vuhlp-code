import { useMemo } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { Canvas, Rect, RoundedRect } from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, useDerivedValue, SharedValue } from 'react-native-reanimated';
import { useGraphStore } from '@/stores/graph-store';
import { colors } from '@/lib/theme';
import {
  MINIMAP_PADDING,
  MINIMAP_PADDING_RATIO,
  getMinimapBounds,
  getMinimapTransform,
  getMinimapWorldPoint,
  getViewportForWorldCenter,
  getMinimapViewportRect,
} from '@vuhlp/shared';

interface GraphMinimapProps {
  width?: number;
  height?: number;
  viewportX: SharedValue<number>;
  viewportY: SharedValue<number>;
  viewportZoom: SharedValue<number>;
}

export function GraphMinimap({ 
  width = 150, 
  height = 100,
  viewportX,
  viewportY,
  viewportZoom,
}: GraphMinimapProps) {
  const screenDimensions = useWindowDimensions();
  const nodes = useGraphStore((s) => s.nodes);
  const viewport = useGraphStore((s) => s.viewport);
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

  // Handle tap/drag to navigate
  const navigateToPoint = (x: number, y: number) => {
    if (!bounds || !transform) return;

    const viewSize = {
      width: viewDimensions.width || screenDimensions.width,
      height: viewDimensions.height || screenDimensions.height,
    };
    const targetWorld = getMinimapWorldPoint(bounds, transform, { x, y });
    const nextViewport = getViewportForWorldCenter(viewSize, targetWorld, viewport.zoom);

    setViewport({ ...viewport, x: nextViewport.x, y: nextViewport.y });
  };

  // Pan gesture for drag navigation
  const panGesture = Gesture.Pan()
    .onUpdate((e) => {
      runOnJS(navigateToPoint)(e.x, e.y);
    });

  // Tap gesture for quick navigation
  const tapGesture = Gesture.Tap()
    .onEnd((e) => {
      runOnJS(navigateToPoint)(e.x, e.y);
    });

  const composedGesture = Gesture.Simultaneous(panGesture, tapGesture);

  // Calculate visible viewport rectangle in minimap coords (derived value for smooth updates)
  const viewSize = {
      width: viewDimensions.width || screenDimensions.width,
      height: viewDimensions.height || screenDimensions.height,
    };
  
  const rectX = useDerivedValue(() => {
    if (!bounds || !transform) return 0;
    const currentZoom = viewportZoom.value || 1;
    const viewWorldLeft = -viewportX.value / currentZoom;
    return (viewWorldLeft - bounds.minX) * transform.scale + transform.offsetX;
  }, [bounds, transform, viewSize, viewportX, viewportY, viewportZoom]);

  const rectY = useDerivedValue(() => {
    if (!bounds || !transform) return 0;
    const currentZoom = viewportZoom.value || 1;
    const viewWorldTop = -viewportY.value / currentZoom;
    return (viewWorldTop - bounds.minY) * transform.scale + transform.offsetY;
  }, [bounds, transform, viewSize, viewportX, viewportY, viewportZoom]);

  const rectWidth = useDerivedValue(() => {
    if (!bounds || !transform) return 0;
    const currentZoom = viewportZoom.value || 1;
    const viewWorldRight = (viewSize.width - viewportX.value) / currentZoom;
    const viewWorldLeft = -viewportX.value / currentZoom;
    return (viewWorldRight - viewWorldLeft) * transform.scale;
  }, [bounds, transform, viewSize, viewportX, viewportY, viewportZoom]);

  const rectHeight = useDerivedValue(() => {
    if (!bounds || !transform) return 0;
    const currentZoom = viewportZoom.value || 1;
    const viewWorldBottom = (viewSize.height - viewportY.value) / currentZoom;
    const viewWorldTop = -viewportY.value / currentZoom;
    return (viewWorldBottom - viewWorldTop) * transform.scale;
  }, [bounds, transform, viewSize, viewportX, viewportY, viewportZoom]);

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
