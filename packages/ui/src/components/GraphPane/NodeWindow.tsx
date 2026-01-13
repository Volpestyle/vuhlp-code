import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Node, NodeTrackedState } from '../../types';
import { NodeWindowHeader } from './NodeWindowHeader';
import { NodeWindowTabs } from './NodeWindowTabs';
import { NodeContentRegistry } from './NodeContentRegistry';
import { ResizeHandles, ResizeDirection } from './ResizeHandles';
import {
  Position,
  Size,
  clamp,
  MIN_WINDOW_SIZE,
  MAX_WINDOW_SIZE,
} from './coordinateUtils';
import './NodeWindow.css';

interface NodeWindowProps {
  node: Node;
  trackedState: NodeTrackedState | undefined;
  screenPosition: Position;
  size: Size; // Already scaled by zoom
  isSelected: boolean;
  onPositionChange: (nodeId: string, deltaX: number, deltaY: number) => void;
  onSizeChange: (nodeId: string, size: Size) => void; // Expects base (unscaled) size
  onSelect: (nodeId: string) => void;
  zoom: number;
}

const PROVIDER_CLASSES: Record<string, string> = {
  claude: 'vuhlp-node-window--claude',
  codex: 'vuhlp-node-window--codex',
  gemini: 'vuhlp-node-window--gemini',
  mock: 'vuhlp-node-window--mock',
};

/**
 * A draggable, resizable window representing a node in the graph.
 */
export function NodeWindow({
  node,
  trackedState,
  screenPosition,
  size,
  isSelected,
  onPositionChange,
  onSizeChange,
  onSelect,
  zoom,
}: NodeWindowProps) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const resizeStartRef = useRef<{
    direction: ResizeDirection;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    startLeft: number;
    startTop: number;
  } | null>(null);

  const isOverviewMode = zoom < 0.6;

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    onSelect(node.id);
  }, [node.id, onSelect]);

  const handleResizeStart = useCallback((direction: ResizeDirection, e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartRef.current = {
      direction,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: size.width,
      startHeight: size.height,
      startLeft: screenPosition.x,
      startTop: screenPosition.y,
    };
    onSelect(node.id);
  }, [node.id, size, screenPosition, onSelect]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(node.id);
  }, [node.id, onSelect]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      onPositionChange(node.id, deltaX, deltaY);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, node.id, onPositionChange]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeStartRef.current) return;
      const { direction, startX, startY, startWidth, startHeight } = resizeStartRef.current;
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      let newWidth = startWidth;
      let newHeight = startHeight;
      let positionDeltaX = 0;
      let positionDeltaY = 0;

      // Handle horizontal resize
      if (direction.includes('e')) {
        newWidth = startWidth + deltaX;
      } else if (direction.includes('w')) {
        newWidth = startWidth - deltaX;
        positionDeltaX = deltaX;
      }

      // Handle vertical resize
      if (direction.includes('s')) {
        newHeight = startHeight + deltaY;
      } else if (direction.includes('n')) {
        newHeight = startHeight - deltaY;
        positionDeltaY = deltaY;
      }

      // Clamp size (scaled min/max)
      const scaledMinWidth = MIN_WINDOW_SIZE.width * zoom;
      const scaledMaxWidth = MAX_WINDOW_SIZE.width * zoom;
      const scaledMinHeight = MIN_WINDOW_SIZE.height * zoom;
      const scaledMaxHeight = MAX_WINDOW_SIZE.height * zoom;

      const clampedWidth = clamp(newWidth, scaledMinWidth, scaledMaxWidth);
      const clampedHeight = clamp(newHeight, scaledMinHeight, scaledMaxHeight);

      // Adjust position delta if size was clamped
      if (direction.includes('w') && clampedWidth !== newWidth) {
        positionDeltaX = startWidth - clampedWidth;
      }
      if (direction.includes('n') && clampedHeight !== newHeight) {
        positionDeltaY = startHeight - clampedHeight;
      }

      // Convert to base size (divide by zoom) before saving
      const baseWidth = clampedWidth / zoom;
      const baseHeight = clampedHeight / zoom;
      onSizeChange(node.id, { width: baseWidth, height: baseHeight });

      // Only update position for west/north resize directions
      if (positionDeltaX !== 0 || positionDeltaY !== 0) {
        const actualDeltaX = positionDeltaX - (resizeStartRef.current.startLeft - screenPosition.x);
        const actualDeltaY = positionDeltaY - (resizeStartRef.current.startTop - screenPosition.y);
        if (actualDeltaX !== 0 || actualDeltaY !== 0) {
          onPositionChange(node.id, actualDeltaX, actualDeltaY);
        }
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      resizeStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, node.id, screenPosition, onPositionChange, onSizeChange, zoom]);

  const providerClass = node.providerId ? PROVIDER_CLASSES[node.providerId] : '';
  const selectedClass = isSelected ? 'vuhlp-node-window--selected' : '';
  const draggingClass = isDragging ? 'vuhlp-node-window--dragging' : '';
  const resizingClass = isResizing ? 'vuhlp-node-window--resizing' : '';
  const overviewClass = isOverviewMode ? 'vuhlp-node-window--overview' : '';

  // Check if window is at max size (using base/unscaled size)
  const baseWidth = size.width / zoom;
  const baseHeight = size.height / zoom;
  const isAtMaxSize = baseWidth >= MAX_WINDOW_SIZE.width - 1 || baseHeight >= MAX_WINDOW_SIZE.height - 1;
  const maxSizeClass = isAtMaxSize ? 'vuhlp-node-window--max-size' : '';

  // Position window with top-left at screenPosition
  // Outer container has scaled dimensions for positioning
  const outerStyle: React.CSSProperties = {
    left: screenPosition.x,
    top: screenPosition.y,
    width: size.width,
    height: size.height,
  };

  // Inner content wrapper has BASE dimensions and uses transform to scale
  // This ensures all text/UI scales proportionally with zoom
  const innerStyle: React.CSSProperties = isOverviewMode ? {
      width: size.width,
      height: size.height,
      transform: 'none',
  } : {
    width: baseWidth,
    height: baseHeight,
    transform: `scale(${zoom})`,
    transformOrigin: 'top left',
  };

  // Determine content to render
  const CustomContent = node.type ? NodeContentRegistry.get(node.type) : undefined;

  return (
    <div
      ref={windowRef}
      className={`vuhlp-node-window ${providerClass} ${selectedClass} ${draggingClass} ${resizingClass} ${maxSizeClass} ${overviewClass}`}
      style={outerStyle}
      onClick={handleClick}
    >
      <div className="vuhlp-node-window__inner" style={innerStyle}>
        {isOverviewMode ? (
             <div className="vuhlp-node-window__overview-content">
                 <span className="vuhlp-node-window__overview-label" title={node.label}>{node.label || node.id.slice(0, 8)}</span>
                 <span className={`vuhlp-node-window__overview-status vuhlp-node-window__status--${node.status}`}>
                     {node.status}
                 </span>
             </div>
        ) : (
            <>
                <NodeWindowHeader node={node} trackedState={trackedState} onMouseDown={handleDragStart} />
                {CustomContent ? (
                  <CustomContent node={node} trackedState={trackedState} />
                ) : (
                  <NodeWindowTabs trackedState={trackedState} />
                )}
            </>
        )}
      </div>
      {!isOverviewMode && <ResizeHandles onResizeStart={handleResizeStart} />}
    </div>
  );
}