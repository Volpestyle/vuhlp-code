/**
 * Coordinate transformation utilities for syncing HTML windows with Cytoscape canvas.
 */

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface ViewportState {
  zoom: number;
  pan: Position;
}

/**
 * Convert Cytoscape model coordinates to screen coordinates.
 * Accounts for zoom level and pan offset.
 */
export function cyToScreen(cyPosition: Position, viewport: ViewportState): Position {
  return {
    x: cyPosition.x * viewport.zoom + viewport.pan.x,
    y: cyPosition.y * viewport.zoom + viewport.pan.y,
  };
}

/**
 * Convert screen coordinates to Cytoscape model coordinates.
 * Used when dragging windows to update Cytoscape node positions.
 */
export function screenToCy(screenPosition: Position, viewport: ViewportState): Position {
  return {
    x: (screenPosition.x - viewport.pan.x) / viewport.zoom,
    y: (screenPosition.y - viewport.pan.y) / viewport.zoom,
  };
}

/**
 * Calculate the top-left corner position for a window given its center position.
 * Cytoscape nodes are positioned by center, but CSS positions by top-left.
 */
export function centerToTopLeft(center: Position, size: Size): Position {
  return {
    x: center.x - size.width / 2,
    y: center.y - size.height / 2,
  };
}

/**
 * Calculate the center position given a top-left corner position.
 */
export function topLeftToCenter(topLeft: Position, size: Size): Position {
  return {
    x: topLeft.x + size.width / 2,
    y: topLeft.y + size.height / 2,
  };
}

/**
 * Clamp a value between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Grid snap size for positioning.
 */
export const SNAP_SIZE = 20;

/**
 * Default window size.
 */
export const DEFAULT_WINDOW_SIZE: Size = {
  width: 600,
  height: 500,
};

/**
 * Window size constraints.
 */
export const MIN_WINDOW_SIZE: Size = {
  width: 200,
  height: 150,
};

export const MAX_WINDOW_SIZE: Size = {
  width: 600,
  height: 500,
};

export const OVERVIEW_WINDOW_SIZE: Size = {
  width: 220,
  height: 140,
};
