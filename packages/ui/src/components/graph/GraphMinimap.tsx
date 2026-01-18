import React, { useMemo } from 'react';
import { useGraphStore } from '../../stores/graph-store';
import { useRunStore } from '../../stores/runStore';
import './GraphMinimap.css';

interface GraphMinimapProps {
  width?: number;
  height?: number;
}

export const GraphMinimap: React.FC<GraphMinimapProps> = ({ 
  width = 200, 
  height = 120 
}) => {
  const nodes = useGraphStore((s) => s.nodes);
  const viewport = useGraphStore((s) => s.viewport);
  const setViewport = useGraphStore((s) => s.setViewport);
  const selectedNodeId = useRunStore((s) => s.ui.selectedNodeId);

  // Constants
  const MINIMAP_PADDING = 720; // Base world padding to keep the minimap zoomed out
  const MINIMAP_PADDING_RATIO = 1.0; // Extra padding based on graph size

  // Calculate the bounding box of the graph
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
    const width = maxX - minX;
    const height = maxY - minY;
    const padX = Math.max(MINIMAP_PADDING, width * MINIMAP_PADDING_RATIO);
    const padY = Math.max(MINIMAP_PADDING, height * MINIMAP_PADDING_RATIO);

    minX -= padX;
    minY -= padY;
    maxX += padX;
    maxY += padY;

    // Ensure non-zero size
    if (maxX <= minX) maxX = minX + 1;
    if (maxY <= minY) maxY = minY + 1;

    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }, [nodes]);

  // Handle interaction
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!bounds) return;

    const element = e.currentTarget;
    const updateViewportFromEvent = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect();
      const clickX = clientX - rect.left;
      const clickY = clientY - rect.top;

      // Calculate scale to fit graph into minimap
      const scaleX = width / bounds.width;
      const scaleY = height / bounds.height;
      const scale = Math.min(scaleX, scaleY);

      // Centering offsets for the rendering
      const offsetX = (width - bounds.width * scale) / 2;
      const offsetY = (height - bounds.height * scale) / 2;

      // Convert click position on minimap to world coordinates
      // clickX = (worldX - bounds.minX) * scale + offsetX
      // worldX = (clickX - offsetX) / scale + bounds.minX
      const targetWorldX = (clickX - offsetX) / scale + bounds.minX;
      const targetWorldY = (clickY - offsetY) / scale + bounds.minY;

      // We want to center the viewport on this world position
      // Viewport x/y is the top-left corner of the view in world space (check GraphCanvas implementation?)
      // Actually, GraphCanvas implementation:
      // worldX = (screenX - viewport.x) / viewport.zoom
      // screenX = worldX * viewport.zoom + viewport.x
      //
      // If we want world point (wx, wy) to be at the center of the screen (sw/2, sh/2):
      // sw/2 = wx * zoom + viewport.x
      // viewport.x = sw/2 - wx * zoom
      
      const screenWidth = window.innerWidth;
      const screenHeight = window.innerHeight;
      
      const newViewportX = screenWidth / 2 - targetWorldX * viewport.zoom;
      const newViewportY = screenHeight / 2 - targetWorldY * viewport.zoom;

      setViewport({ ...viewport, x: newViewportX, y: newViewportY }, true);
    };

    updateViewportFromEvent(e.clientX, e.clientY);

    const onPointerMove = (moveEvent: PointerEvent) => {
      updateViewportFromEvent(moveEvent.clientX, moveEvent.clientY);
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  if (!bounds) return null;

  // Calculate rendering transform
  const scaleX = width / bounds.width;
  const scaleY = height / bounds.height;
  const scale = Math.min(scaleX, scaleY);
  const offsetX = (width - bounds.width * scale) / 2;
  const offsetY = (height - bounds.height * scale) / 2;

  // Viewport rect calculation
  // Visible world area:
  // left = (0 - vx) / zoom
  // top = (0 - vy) / zoom
  // right = (screenWidth - vx) / zoom
  // bottom = (screenHeight - vy) / zoom
  
  const screenWidth = window.innerWidth; // TODO: Get actual canvas size if possible, though window is usually close in this app
  const screenHeight = window.innerHeight;

  const viewWorldLeft = -viewport.x / viewport.zoom;
  const viewWorldTop = -viewport.y / viewport.zoom;
  const viewWorldRight = (screenWidth - viewport.x) / viewport.zoom;
  const viewWorldBottom = (screenHeight - viewport.y) / viewport.zoom;

  // Map view world rect to minimap rect
  const viewMiniLeft = (viewWorldLeft - bounds.minX) * scale + offsetX;
  const viewMiniTop = (viewWorldTop - bounds.minY) * scale + offsetY;
  const viewMiniWidth = (viewWorldRight - viewWorldLeft) * scale;
  const viewMiniHeight = (viewWorldBottom - viewWorldTop) * scale;

  return (
    <div 
      className="graph-minimap" 
      style={{ width, height }}
      onPointerDown={handlePointerDown}
    >
      <svg width={width} height={height}>
        {/* Render Nodes */}
        {nodes.map((node) => {
          const x = (node.position.x - bounds.minX) * scale + offsetX;
          const y = (node.position.y - bounds.minY) * scale + offsetY;
          const w = node.dimensions.width * scale;
          const h = node.dimensions.height * scale;
          
          const isActive = node.id === selectedNodeId;
          
          return (
            <rect
              key={node.id}
              x={x}
              y={y}
              width={Math.max(2, w)} // Ensure visible even if small
              height={Math.max(2, h)}
              className={`graph-minimap__node ${isActive ? 'graph-minimap__node--active' : ''}`}
            />
          );
        })}

        {/* Render Viewport Rect */}
        <rect
          x={viewMiniLeft}
          y={viewMiniTop}
          width={Math.max(1, viewMiniWidth)}
          height={Math.max(1, viewMiniHeight)}
          className="graph-minimap__viewport"
        />
      </svg>
    </div>
  );
};
