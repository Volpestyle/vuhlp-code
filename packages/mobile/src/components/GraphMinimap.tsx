import { useMemo } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { Canvas, Rect, RoundedRect } from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useGraphStore } from '@/stores/graph-store';
import { colors } from '@/lib/theme';

interface GraphMinimapProps {
  width?: number;
  height?: number;
}

// Constants
const MINIMAP_PADDING = 720; // Base world padding to keep the minimap zoomed out
const MINIMAP_PADDING_RATIO = 1.0; // Extra padding based on graph size

export function GraphMinimap({ width = 150, height = 100 }: GraphMinimapProps) {
  const screenDimensions = useWindowDimensions();
  const nodes = useGraphStore((s) => s.nodes);
  const viewport = useGraphStore((s) => s.viewport);
  const viewDimensions = useGraphStore((s) => s.viewDimensions);
  const setViewport = useGraphStore((s) => s.setViewport);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);

  // Calculate the bounding box of all nodes with padding
  const bounds = useMemo(() => {
    if (nodes.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    nodes.forEach((node) => {
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + node.dimensions.width);
      maxY = Math.max(maxY, node.position.y + node.dimensions.height);
    });

    // Add padding
    const boundsWidth = maxX - minX;
    const boundsHeight = maxY - minY;
    const padX = Math.max(MINIMAP_PADDING, boundsWidth * MINIMAP_PADDING_RATIO);
    const padY = Math.max(MINIMAP_PADDING, boundsHeight * MINIMAP_PADDING_RATIO);

    minX -= padX;
    minY -= padY;
    maxX += padX;
    maxY += padY;

    // Ensure non-zero size
    if (maxX <= minX) maxX = minX + 1;
    if (maxY <= minY) maxY = minY + 1;

    return {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }, [nodes]);

  // Calculate transform for rendering
  const transform = useMemo(() => {
    if (!bounds) return null;

    const scaleX = width / bounds.width;
    const scaleY = height / bounds.height;
    const scale = Math.min(scaleX, scaleY);
    const offsetX = (width - bounds.width * scale) / 2;
    const offsetY = (height - bounds.height * scale) / 2;

    return { scale, offsetX, offsetY };
  }, [bounds, width, height]);

  // Handle tap/drag to navigate
  const navigateToPoint = (x: number, y: number) => {
    if (!bounds || !transform) return;

    // Convert minimap coords to world coords
    const targetWorldX = (x - transform.offsetX) / transform.scale + bounds.minX;
    const targetWorldY = (y - transform.offsetY) / transform.scale + bounds.minY;

    // Center viewport on this world position
    // viewport.x = screenWidth/2 - worldX * zoom
    // We use the view dimensions here to center correctly
    const viewW = viewDimensions.width || screenDimensions.width;
    const viewH = viewDimensions.height || screenDimensions.height;
    
    const newViewportX = viewW / 2 - targetWorldX * viewport.zoom;
    const newViewportY = viewH / 2 - targetWorldY * viewport.zoom;

    setViewport({ ...viewport, x: newViewportX, y: newViewportY });
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
  const viewW = viewDimensions.width || screenDimensions.width;
  const viewH = viewDimensions.height || screenDimensions.height;

  const viewWorldLeft = -viewport.x / viewport.zoom;
  const viewWorldTop = -viewport.y / viewport.zoom;
  const viewWorldRight = (viewW - viewport.x) / viewport.zoom;
  const viewWorldBottom = (viewH - viewport.y) / viewport.zoom;

  const viewMiniLeft = (viewWorldLeft - bounds.minX) * transform.scale + transform.offsetX;
  const viewMiniTop = (viewWorldTop - bounds.minY) * transform.scale + transform.offsetY;
  const viewMiniWidth = (viewWorldRight - viewWorldLeft) * transform.scale;
  const viewMiniHeight = (viewWorldBottom - viewWorldTop) * transform.scale;

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
