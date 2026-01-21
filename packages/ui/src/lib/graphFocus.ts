import type { VisualNode } from '../types/graph';

export interface ViewportSize {
  width: number;
  height: number;
}

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

const FOCUS_PADDING = 80;
const FOCUS_MAX_ZOOM = 6;
const MIN_MID_ZOOM = 1.4;

export function getFocusZoomLevels(node: VisualNode, size: ViewportSize) {
  if (!size.width || !size.height) {
    return { fullZoom: 1, midZoom: 1 };
  }

  const availableWidth = Math.max(1, size.width - FOCUS_PADDING);
  const availableHeight = Math.max(1, size.height - FOCUS_PADDING);
  const fullZoom = Math.min(
    FOCUS_MAX_ZOOM,
    availableWidth / node.dimensions.width,
    availableHeight / node.dimensions.height
  );
  const clampedFullZoom = Math.max(0.1, fullZoom);
  const midZoom = Math.min(
    clampedFullZoom * 0.92,
    Math.max(MIN_MID_ZOOM, clampedFullZoom * 0.65)
  );

  return { fullZoom: clampedFullZoom, midZoom };
}

export function getViewportForNode(
  node: VisualNode,
  size: ViewportSize,
  zoom: number
): GraphViewport {
  const centerX = node.position.x + node.dimensions.width / 2;
  const centerY = node.position.y + node.dimensions.height / 2;
  return {
    x: size.width / 2 - centerX * zoom,
    y: size.height / 2 - centerY * zoom,
    zoom,
  };
}
