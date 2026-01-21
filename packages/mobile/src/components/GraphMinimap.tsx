import { useMemo } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { Canvas, Rect, RoundedRect } from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
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
}

export function GraphMinimap({ width = 150, height = 100 }: GraphMinimapProps) {
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

  if (!bounds || !transform) {
    return null;
  }

  // Calculate visible viewport rectangle in minimap coords
  const viewSize = {
    width: viewDimensions.width || screenDimensions.width,
    height: viewDimensions.height || screenDimensions.height,
  };
  const viewRect = getMinimapViewportRect(bounds, transform, viewport, viewSize);

  const viewMiniLeft = viewRect.x;
  const viewMiniTop = viewRect.y;
  const viewMiniWidth = viewRect.width;
  const viewMiniHeight = viewRect.height;

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
            x={Math.max(0, viewMiniLeft)}
            y={Math.max(0, viewMiniTop)}
            width={Math.min(width, Math.max(1, viewMiniWidth))}
            height={Math.min(height, Math.max(1, viewMiniHeight))}
            color={colors.accentGlow}
          />
          <Rect
            x={Math.max(0, viewMiniLeft)}
            y={Math.max(0, viewMiniTop)}
            width={Math.min(width, Math.max(1, viewMiniWidth))}
            height={Math.min(height, Math.max(1, viewMiniHeight))}
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
    position: 'absolute',
    top: 0,
    left: 0,
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
