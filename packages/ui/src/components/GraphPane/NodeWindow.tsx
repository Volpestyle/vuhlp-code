import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Node, NodeTrackedState } from '../../types';
import { NodeWindowHeader } from './NodeWindowHeader';
import { NodeWindowTabs } from './NodeWindowTabs';
import { NodeContentRegistry } from './NodeContentRegistry';
import {
  Position,
  Size,
} from './coordinateUtils';
import './NodeWindow.css';

const MODE_TRANSITION_MS = 180;


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
  onContextMenu?: (nodeId: string, e: React.MouseEvent) => void;
  onMessage?: (nodeId: string, content: string) => void;
  zoom: number;
  artifacts?: Array<import('../../types').Artifact>;
  onStopNode?: (nodeId: string) => void;
  onRestartNode?: (nodeId: string) => void;
  isFocused?: boolean;
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
  onContextMenu,
  onMessage,
  zoom,
  artifacts = [],
  onStopNode,
  onRestartNode,
  isFocused,
}: NodeWindowProps) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [transitionScale, setTransitionScale] = useState<{ x: number; y: number } | null>(null);
  
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const initialPositionRef = useRef<Position | null>(null);
  const fullSizeRef = useRef<Size>(size);
  const overviewSizeRef = useRef<Size | null>(null);
  const previousOverviewRef = useRef<boolean>(isOverview);
  const transitionRafRef = useRef<number | null>(null);
  const transitionTimeoutRef = useRef<number | null>(null);

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

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(node.id, e);
  }, [node.id, onContextMenu]);

  const handleMessage = useCallback((content: string) => {
    onMessage?.(node.id, content);
  }, [node.id, onMessage]);

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
    if (!isOverview) {
      fullSizeRef.current = size;
    }
  }, [isOverview, size.width, size.height]);

  useLayoutEffect(() => {
    if (!isOverview) return;
    const nodeElement = windowRef.current;
    if (!nodeElement) return;
    const rect = nodeElement.getBoundingClientRect();
    overviewSizeRef.current = { width: rect.width, height: rect.height };
  }, [isOverview, node.label, node.status]);

  useLayoutEffect(() => {
    const wasOverview = previousOverviewRef.current;
    if (wasOverview === isOverview) return;

    const fromSize = wasOverview ? overviewSizeRef.current : fullSizeRef.current;
    const toSize = isOverview ? overviewSizeRef.current : size;

    previousOverviewRef.current = isOverview;

    if (!fromSize || !toSize) return;
    if (toSize.width <= 0 || toSize.height <= 0) return;

    const scaleX = fromSize.width / toSize.width;
    const scaleY = fromSize.height / toSize.height;

    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return;
    if (Math.abs(scaleX - 1) < 0.01 && Math.abs(scaleY - 1) < 0.01) return;

    if (transitionRafRef.current !== null) {
      window.cancelAnimationFrame(transitionRafRef.current);
      transitionRafRef.current = null;
    }
    if (transitionTimeoutRef.current !== null) {
      window.clearTimeout(transitionTimeoutRef.current);
      transitionTimeoutRef.current = null;
    }

    setTransitionScale({ x: scaleX, y: scaleY });
    transitionRafRef.current = window.requestAnimationFrame(() => {
      setTransitionScale({ x: 1, y: 1 });
    });
    transitionTimeoutRef.current = window.setTimeout(() => {
      setTransitionScale(null);
    }, MODE_TRANSITION_MS);
  }, [isOverview, size.width, size.height]);

  useEffect(() => {
    return () => {
      if (transitionRafRef.current !== null) {
        window.cancelAnimationFrame(transitionRafRef.current);
        transitionRafRef.current = null;
      }
      if (transitionTimeoutRef.current !== null) {
        window.clearTimeout(transitionTimeoutRef.current);
        transitionTimeoutRef.current = null;
      }
    };
  }, []);

  const providerClass = node.providerId ? PROVIDER_CLASSES[node.providerId] : '';
  const selectedClass = isSelected ? 'vuhlp-node-window--selected' : '';
  const highlightedClass = isHighlighted ? 'vuhlp-node-window--highlighted' : '';
  const dimmedClass = isDimmed ? 'vuhlp-node-window--dimmed' : '';
  const draggingClass = isDragging ? 'vuhlp-node-window--dragging' : '';
  const overviewClass = isOverview ? 'vuhlp-node-window--overview' : '';
  const statusClass = `vuhlp-node-window--status-${node.status}`;
  const isInteractive = zoom >= 0.9;
  const interactiveClass = isInteractive ? 'vuhlp-node-window--interactive' : '';
  const modeTransitionClass = transitionScale ? 'vuhlp-node-window--mode-transition' : '';

  // Cap the content scale to prevent text from getting too large when zoomed in
  // Window container still gets larger, but inner content stays readable
  const MAX_CONTENT_SCALE = 1.0;
  const contentZoom = Math.min(zoom, MAX_CONTENT_SCALE);

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
    // In overview mode, only set a small minimum - don't use full size
    minWidth: isOverview ? 120 : undefined,
    minHeight: isOverview ? undefined : undefined,
    transform: transitionScale ? `scale(${transitionScale.x}, ${transitionScale.y})` : undefined,
    transformOrigin: 'center center',
  };

  // Inner content wrapper has BASE dimensions and uses transform to scale
  // Content uses contentZoom (capped) so text doesn't get too large when zoomed in far
  // The outer container still uses full zoom for sizing, giving more readable space
  const contentWidth = baseWidth * (zoom / contentZoom);
  const contentHeight = baseHeight * (zoom / contentZoom);

  const innerStyle: React.CSSProperties = isOverview ? {
    minWidth: '100%',
    minHeight: '100%',
    transform: 'none',
  } : {
    width: contentWidth,
    height: contentHeight,
    transform: `scale(${contentZoom})`,
    transformOrigin: 'top left',
  };

  // Determine content to render
  const CustomContent = node.type ? NodeContentRegistry.get(node.type) : undefined;

  return (
    <div
      ref={windowRef}
      className={`vuhlp-node-window ${providerClass} ${selectedClass} ${highlightedClass} ${dimmedClass} ${draggingClass} ${overviewClass} ${statusClass} ${interactiveClass} ${modeTransitionClass} ${isFocused ? 'vuhlp-node-window--focused' : ''}`}
      style={outerStyle}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onWheel={(e) => {
        if (isFocused) {
          e.stopPropagation();
        }
      }}
    >
      <div className="vuhlp-node-window__clip-mask">
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
              <NodeWindowHeader 
                node={node} 
                trackedState={trackedState} 
                onMouseDown={handleDragStart} 
                onStop={() => onStopNode?.(node.id)}
                onRestart={() => onRestartNode?.(node.id)}
              />
              {CustomContent ? (
                <CustomContent node={node} trackedState={trackedState} />
              ) : (
                  <NodeWindowTabs 
                    trackedState={trackedState}
                    onMessage={handleMessage}
                    isInteractive={isInteractive}
                    artifacts={artifacts}
                    node={node}
                  />
              )}
            </>
          )}
        </div>
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
