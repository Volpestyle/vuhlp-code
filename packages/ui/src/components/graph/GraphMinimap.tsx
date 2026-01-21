import React, { useMemo } from 'react';
import {
  MINIMAP_PADDING,
  MINIMAP_PADDING_RATIO,
  getMinimapBounds,
  getMinimapTransform,
  getMinimapWorldPoint,
  getViewportForWorldCenter,
  getMinimapViewportRect,
} from '@vuhlp/shared';
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

  // Calculate the bounding box of the graph
  const bounds = useMemo(
    () =>
      getMinimapBounds(nodes, {
        padding: MINIMAP_PADDING,
        paddingRatio: MINIMAP_PADDING_RATIO,
      }),
    [nodes]
  );
  const transform = useMemo(() => {
    if (!bounds) return null;
    return getMinimapTransform(bounds, { width, height });
  }, [bounds, width, height]);

  // Handle interaction
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!bounds || !transform) return;

    const element = e.currentTarget;
    const updateViewportFromEvent = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect();
      const clickX = clientX - rect.left;
      const clickY = clientY - rect.top;

      const targetWorld = getMinimapWorldPoint(bounds, transform, { x: clickX, y: clickY });
      const viewSize = { width: window.innerWidth, height: window.innerHeight };
      const nextViewport = getViewportForWorldCenter(viewSize, targetWorld, viewport.zoom);

      setViewport({ ...viewport, x: nextViewport.x, y: nextViewport.y }, true);
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

  if (!bounds || !transform) return null;

  const viewSize = {
    width: window.innerWidth,
    height: window.innerHeight,
  };
  const viewRect = getMinimapViewportRect(bounds, transform, viewport, viewSize);

  const viewMiniLeft = viewRect.x;
  const viewMiniTop = viewRect.y;
  const viewMiniWidth = viewRect.width;
  const viewMiniHeight = viewRect.height;

  return (
    <div 
      className="graph-minimap" 
      style={{ width, height }}
      onPointerDown={handlePointerDown}
    >
      <svg width={width} height={height}>
        {/* Render Nodes */}
        {nodes.map((node) => {
          const x = (node.position.x - bounds.minX) * transform.scale + transform.offsetX;
          const y = (node.position.y - bounds.minY) * transform.scale + transform.offsetY;
          const w = node.dimensions.width * transform.scale;
          const h = node.dimensions.height * transform.scale;
          
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
