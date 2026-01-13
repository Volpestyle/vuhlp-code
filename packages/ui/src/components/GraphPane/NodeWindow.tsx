import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Node, NodeTrackedState } from '../../types';
import { NodeWindowHeader } from './NodeWindowHeader';
import { NodeWindowTabs } from './NodeWindowTabs';
import { NodeContentRegistry } from './NodeContentRegistry';
import {
  Position,
  Size,
} from './coordinateUtils';
import './NodeWindow.css';

interface NodeWindowProps {
  node: Node;
  trackedState: NodeTrackedState | undefined;
  screenPosition: Position;
  size: Size; // Already scaled by zoom
  isSelected: boolean;
  isHighlighted?: boolean;
  isDimmed: boolean;
  isOverview: boolean;
  onPositionChange: (
    nodeId: string,
    deltaX: number,
    deltaY: number,
    options?: { snap?: boolean }
  ) => void;
  onPositionCommit?: (nodeId: string) => void;

  onSelect: (nodeId: string) => void;
  onPortMouseDown?: (nodeId: string, port: 'input' | 'output', e: React.MouseEvent) => void;
  onPortClick?: (nodeId: string, port: 'input' | 'output', e: React.MouseEvent) => void;
  onDoubleClick?: (nodeId: string) => void;
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
  isHighlighted,
  isDimmed,
  isOverview,
  onPositionChange,
  onPositionCommit,
  onSelect,
  onPortMouseDown,
  onPortClick,
  onDoubleClick,
  zoom,
}: NodeWindowProps) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const initialPositionRef = useRef<Position | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    initialPositionRef.current = screenPosition;
    setDragOffset({ x: 0, y: 0 });
    onSelect(node.id);
  }, [node.id, onSelect, screenPosition]);


  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(node.id);
  }, [node.id, onSelect]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDoubleClick?.(node.id);
  }, [node.id, onDoubleClick]);

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

  const providerClass = node.providerId ? PROVIDER_CLASSES[node.providerId] : '';
  const selectedClass = isSelected ? 'vuhlp-node-window--selected' : '';
  const highlightedClass = isHighlighted ? 'vuhlp-node-window--highlighted' : '';
  const dimmedClass = isDimmed ? 'vuhlp-node-window--dimmed' : '';
  const draggingClass = isDragging ? 'vuhlp-node-window--dragging' : '';
  const overviewClass = isOverview ? 'vuhlp-node-window--overview' : '';
  const statusClass = `vuhlp-node-window--status-${node.status}`;

  // Check if window is at max size (using base/unscaled size)
  const baseWidth = size.width / zoom;
  const baseHeight = size.height / zoom;

  // Calculate effective position (local override during drag)
  let effectivePosition = screenPosition;

  if (isDragging && initialPositionRef.current) {
    effectivePosition = {
      x: initialPositionRef.current.x + dragOffset.x,
      y: initialPositionRef.current.y + dragOffset.y,
    };
  }

  // Position window with top-left at screenPosition
  // Outer container has scaled dimensions for positioning
  const outerStyle: React.CSSProperties = {
    left: effectivePosition.x,
    top: effectivePosition.y,
    width: isOverview ? 'auto' : size.width,
    height: isOverview ? 'auto' : size.height,
    minWidth: isOverview ? size.width : undefined,
    minHeight: isOverview ? size.height : undefined,
  };

  // Inner content wrapper has BASE dimensions and uses transform to scale
  // This ensures all text/UI scales proportionally with zoom
  const innerStyle: React.CSSProperties = isOverview ? {
    minWidth: '100%',
    minHeight: '100%',
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
      className={`vuhlp-node-window ${providerClass} ${selectedClass} ${highlightedClass} ${dimmedClass} ${draggingClass} ${overviewClass} ${statusClass}`}
      style={outerStyle}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
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
            onClick={(e) => {
              e.stopPropagation();
              onPortClick?.(node.id, 'input', e);
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
            onClick={(e) => {
              e.stopPropagation();
              onPortClick?.(node.id, 'output', e);
            }}
          />
        </>
      )}
    </div>
  );
}
