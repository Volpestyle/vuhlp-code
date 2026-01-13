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
  isDimmed: boolean;
  isOverview: boolean;
  onPositionChange: (
    nodeId: string,
    deltaX: number,
    deltaY: number,
    options?: { snap?: boolean }
  ) => void;
  onPositionCommit?: (nodeId: string) => void;
  onSizeChange: (nodeId: string, size: Size) => void; // Expects base (unscaled) size
  onSelect: (nodeId: string) => void;
  onPortMouseDown?: (nodeId: string, port: 'input' | 'output', e: React.MouseEvent) => void;
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
  isDimmed,
  isOverview,
  onPositionChange,
  onPositionCommit,
  onSizeChange,
  onSelect,
  onPortMouseDown,
  zoom,
}: NodeWindowProps) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [resizeDelta, setResizeDelta] = useState({ x: 0, y: 0, w: 0, h: 0 });
  
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const initialPositionRef = useRef<Position | null>(null);

  const resizeStartRef = useRef<{
    direction: ResizeDirection;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    startLeft: number;
    startTop: number;
  } | null>(null);

  // Track cumulative center delta for computing frame deltas during resize
  // Center moves by half the size change for ALL resize directions
  const prevCenterDeltaRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    initialPositionRef.current = screenPosition;
    setDragOffset({ x: 0, y: 0 });
    onSelect(node.id);
  }, [node.id, onSelect, screenPosition]);

  const handleResizeStart = useCallback((direction: ResizeDirection, e: React.MouseEvent) => {
    if (isOverview) return;
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
    prevCenterDeltaRef.current = { x: 0, y: 0 };
    setResizeDelta({ x: 0, y: 0, w: 0, h: 0 });
    onSelect(node.id);
  }, [isOverview, node.id, size, screenPosition, onSelect]);

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
      setDragOffset((prev) => ({ x: prev.x + deltaX, y: prev.y + deltaY }));
      onPositionChange(node.id, deltaX, deltaY, { snap: false });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
      initialPositionRef.current = null;
      onPositionCommit?.(node.id);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, node.id, onPositionChange, onPositionCommit]);

  useEffect(() => {
    if (!isResizing || isOverview) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeStartRef.current) return;
      const { direction, startX, startY, startWidth, startHeight } = resizeStartRef.current;

      // Calculate total mouse delta from start
      const totalDeltaX = e.clientX - startX;
      const totalDeltaY = e.clientY - startY;

      // Calculate new size based on resize direction
      let newWidth = startWidth;
      let newHeight = startHeight;

      if (direction.includes('e')) {
        newWidth = startWidth + totalDeltaX;
      } else if (direction.includes('w')) {
        newWidth = startWidth - totalDeltaX;
      }

      if (direction.includes('s')) {
        newHeight = startHeight + totalDeltaY;
      } else if (direction.includes('n')) {
        newHeight = startHeight - totalDeltaY;
      }

      // Clamp size (scaled min/max)
      const scaledMinWidth = MIN_WINDOW_SIZE.width * zoom;
      const scaledMaxWidth = MAX_WINDOW_SIZE.width * zoom;
      const scaledMinHeight = MIN_WINDOW_SIZE.height * zoom;
      const scaledMaxHeight = MAX_WINDOW_SIZE.height * zoom;

      const clampedWidth = clamp(newWidth, scaledMinWidth, scaledMaxWidth);
      const clampedHeight = clamp(newHeight, scaledMinHeight, scaledMaxHeight);

      // Calculate actual size change after clamping
      const widthChange = clampedWidth - startWidth;
      const heightChange = clampedHeight - startHeight;

      // Calculate top-left position delta for visual rendering
      // W/N: top-left moves when edge moves (but clamped to actual size change)
      // E/S: top-left doesn't move
      let topLeftDeltaX = 0;
      let topLeftDeltaY = 0;

      if (direction.includes('w')) {
        // For W resize, left edge moves by -widthChange (grows left = negative)
        topLeftDeltaX = -widthChange;
      }
      if (direction.includes('n')) {
        // For N resize, top edge moves by -heightChange (grows up = negative)
        topLeftDeltaY = -heightChange;
      }

      // Update local state for visual rendering
      setResizeDelta({
        w: widthChange,
        h: heightChange,
        x: topLeftDeltaX,
        y: topLeftDeltaY,
      });

      // Convert to base size (divide by zoom) before saving
      const baseWidth = clampedWidth / zoom;
      const baseHeight = clampedHeight / zoom;
      onSizeChange(node.id, { width: baseWidth, height: baseHeight });

      // Calculate center position change for Cytoscape
      // KEY INSIGHT: Center moves by HALF the size change for ALL resize directions
      //
      // For W resize: center moves LEFT by widthChange/2 (as width grows, center shifts left)
      // For E resize: center moves RIGHT by widthChange/2 (as width grows, center shifts right)
      // For N resize: center moves UP by heightChange/2 (as height grows, center shifts up)
      // For S resize: center moves DOWN by heightChange/2 (as height grows, center shifts down)
      //
      // The sign depends on direction:
      // W: centerDeltaX = -widthChange / 2 (negative because growing left shifts center left)
      // E: centerDeltaX = widthChange / 2 (positive because growing right shifts center right)
      // N: centerDeltaY = -heightChange / 2
      // S: centerDeltaY = heightChange / 2

      let totalCenterDeltaX = 0;
      let totalCenterDeltaY = 0;

      if (direction.includes('w')) {
        totalCenterDeltaX = -widthChange / 2;
      } else if (direction.includes('e')) {
        totalCenterDeltaX = widthChange / 2;
      }

      if (direction.includes('n')) {
        totalCenterDeltaY = -heightChange / 2;
      } else if (direction.includes('s')) {
        totalCenterDeltaY = heightChange / 2;
      }

      // Calculate frame delta by comparing to previous cumulative center delta
      const frameCenterDeltaX = totalCenterDeltaX - prevCenterDeltaRef.current.x;
      const frameCenterDeltaY = totalCenterDeltaY - prevCenterDeltaRef.current.y;
      prevCenterDeltaRef.current = { x: totalCenterDeltaX, y: totalCenterDeltaY };

      // Send frame delta to parent (parent accumulates and updates Cytoscape)
      if (frameCenterDeltaX !== 0 || frameCenterDeltaY !== 0) {
        onPositionChange(node.id, frameCenterDeltaX, frameCenterDeltaY, { snap: false });
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      resizeStartRef.current = null;
      prevCenterDeltaRef.current = { x: 0, y: 0 };
      setResizeDelta({ x: 0, y: 0, w: 0, h: 0 });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, isOverview, node.id, onPositionChange, onSizeChange, zoom]);

  const providerClass = node.providerId ? PROVIDER_CLASSES[node.providerId] : '';
  const selectedClass = isSelected ? 'vuhlp-node-window--selected' : '';
  const dimmedClass = isDimmed ? 'vuhlp-node-window--dimmed' : '';
  const draggingClass = isDragging ? 'vuhlp-node-window--dragging' : '';
  const resizingClass = isResizing ? 'vuhlp-node-window--resizing' : '';
  const overviewClass = isOverview ? 'vuhlp-node-window--overview' : '';
  const statusClass = `vuhlp-node-window--status-${node.status}`;

  // Calculate effective size (local override during resize)
  const effectiveSize = isResizing ? {
    width: resizeStartRef.current!.startWidth + resizeDelta.w,
    height: resizeStartRef.current!.startHeight + resizeDelta.h
  } : size;

  // Check if window is at max size (using base/unscaled size)
  const baseWidth = effectiveSize.width / zoom;
  const baseHeight = effectiveSize.height / zoom;
  const isAtMaxSize = baseWidth >= MAX_WINDOW_SIZE.width - 1 || baseHeight >= MAX_WINDOW_SIZE.height - 1;
  const maxSizeClass = isAtMaxSize ? 'vuhlp-node-window--max-size' : '';

  // Calculate effective position (local override during drag OR resize)
  let effectivePosition = screenPosition;

  if (isDragging && initialPositionRef.current) {
    effectivePosition = {
      x: initialPositionRef.current.x + dragOffset.x,
      y: initialPositionRef.current.y + dragOffset.y,
    };
  } else if (isResizing && resizeStartRef.current) {
     effectivePosition = {
         x: resizeStartRef.current.startLeft + resizeDelta.x,
         y: resizeStartRef.current.startTop + resizeDelta.y
     };
  }

  // Position window with top-left at screenPosition
  // Outer container has scaled dimensions for positioning
  const outerStyle: React.CSSProperties = {
    left: effectivePosition.x,
    top: effectivePosition.y,
    width: effectiveSize.width,
    height: effectiveSize.height,
  };

  // Inner content wrapper has BASE dimensions and uses transform to scale
  // This ensures all text/UI scales proportionally with zoom
  const innerStyle: React.CSSProperties = isOverview ? {
    width: effectiveSize.width,
    height: effectiveSize.height,
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
      className={`vuhlp-node-window ${providerClass} ${selectedClass} ${dimmedClass} ${draggingClass} ${resizingClass} ${maxSizeClass} ${overviewClass} ${statusClass}`}
      style={outerStyle}
      onClick={handleClick}
    >
      <div className="vuhlp-node-window__inner" style={innerStyle}>
        {isOverview ? (
          <div className="vuhlp-node-window__overview-content" onMouseDown={handleDragStart}>
            <span className="vuhlp-node-window__overview-label" title={node.label}>
              {node.label || node.id.slice(0, 8)}
            </span>
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
      {!isOverview && (
        <>
          <div 
            className="vuhlp-node-port vuhlp-node-port--input" 
            data-node-id={node.id} 
            data-port="input"
            onMouseDown={(e) => {
              e.stopPropagation();
              onPortMouseDown?.(node.id, 'input', e);
            }}
          />
          <div 
            className="vuhlp-node-port vuhlp-node-port--output" 
            data-node-id={node.id} 
            data-port="output"
            onMouseDown={(e) => {
              e.stopPropagation();
              onPortMouseDown?.(node.id, 'output', e);
            }}
          />
          <ResizeHandles onResizeStart={handleResizeStart} />
        </>
      )}
    </div>
  );
}
