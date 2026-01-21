export const MINIMAP_PADDING = 720;
export const MINIMAP_PADDING_RATIO = 1;

export interface MinimapPoint {
  x: number;
  y: number;
}

export interface MinimapNode {
  position: MinimapPoint;
  dimensions: {
    width: number;
    height: number;
  };
}

export interface MinimapBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface MinimapSize {
  width: number;
  height: number;
}

export interface MinimapTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface ViewportLike {
  x: number;
  y: number;
  zoom: number;
}

export interface MinimapViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getMinimapBounds(
  nodes: MinimapNode[],
  options?: { padding?: number; paddingRatio?: number }
): MinimapBounds | null {
  if (nodes.length === 0) return null;

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

  const boundsWidth = maxX - minX;
  const boundsHeight = maxY - minY;
  const padding = options?.padding ?? MINIMAP_PADDING;
  const paddingRatio = options?.paddingRatio ?? MINIMAP_PADDING_RATIO;
  const padX = Math.max(padding, boundsWidth * paddingRatio);
  const padY = Math.max(padding, boundsHeight * paddingRatio);

  const paddedMinX = minX - padX;
  const paddedMinY = minY - padY;
  const paddedMaxX = maxX + padX;
  const paddedMaxY = maxY + padY;

  let finalMaxX = paddedMaxX;
  let finalMaxY = paddedMaxY;
  if (finalMaxX <= paddedMinX) finalMaxX = paddedMinX + 1;
  if (finalMaxY <= paddedMinY) finalMaxY = paddedMinY + 1;

  return {
    minX: paddedMinX,
    minY: paddedMinY,
    maxX: finalMaxX,
    maxY: finalMaxY,
    width: finalMaxX - paddedMinX,
    height: finalMaxY - paddedMinY,
  };
}

export function getMinimapTransform(
  bounds: MinimapBounds,
  size: MinimapSize
): MinimapTransform {
  const scaleX = size.width / bounds.width;
  const scaleY = size.height / bounds.height;
  const scale = Math.min(scaleX, scaleY);
  const offsetX = (size.width - bounds.width * scale) / 2;
  const offsetY = (size.height - bounds.height * scale) / 2;

  return { scale, offsetX, offsetY };
}

export function getMinimapWorldPoint(
  bounds: MinimapBounds,
  transform: MinimapTransform,
  point: MinimapPoint
): MinimapPoint {
  return {
    x: (point.x - transform.offsetX) / transform.scale + bounds.minX,
    y: (point.y - transform.offsetY) / transform.scale + bounds.minY,
  };
}

export function getViewportForWorldCenter(
  viewSize: MinimapSize,
  worldPoint: MinimapPoint,
  zoom: number
): { x: number; y: number } {
  return {
    x: viewSize.width / 2 - worldPoint.x * zoom,
    y: viewSize.height / 2 - worldPoint.y * zoom,
  };
}

export function getMinimapViewportRect(
  bounds: MinimapBounds,
  transform: MinimapTransform,
  viewport: ViewportLike,
  viewSize: MinimapSize
): MinimapViewportRect {
  const viewWorldLeft = -viewport.x / viewport.zoom;
  const viewWorldTop = -viewport.y / viewport.zoom;
  const viewWorldRight = (viewSize.width - viewport.x) / viewport.zoom;
  const viewWorldBottom = (viewSize.height - viewport.y) / viewport.zoom;

  return {
    x: (viewWorldLeft - bounds.minX) * transform.scale + transform.offsetX,
    y: (viewWorldTop - bounds.minY) * transform.scale + transform.offsetY,
    width: (viewWorldRight - viewWorldLeft) * transform.scale,
    height: (viewWorldBottom - viewWorldTop) * transform.scale,
  };
}
