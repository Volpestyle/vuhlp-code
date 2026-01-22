import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Node, NodeTrackedState } from '../../types';
import { NodeWindowHeader } from './NodeWindowHeader';
import { NodeWindowTabs } from './NodeWindowTabs';
import { NodeContentRegistry } from './NodeContentRegistry';
import {
  Position,
  Size,
  MAX_WINDOW_SIZE,
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
    options?: { snap?: boolean; transient?: boolean }
  ) => void;
  onPositionCommit?: (nodeId: string) => void;
  onSelect: (nodeId: string) => void;
  onPortMouseDown?: (nodeId: string, port: 'input' | 'output' | 'left' | 'right', e: React.MouseEvent) => void;
  onPortClick?: (nodeId: string, port: 'input' | 'output' | 'left' | 'right', e: React.MouseEvent) => void;
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
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null);
  const initialPositionRef = useRef<Position | null>(null);
  const fullSizeRef = useRef<Size>(size);
  const overviewSizeRef = useRef<Size | null>(null);
  const previousOverviewRef = useRef<boolean>(isOverview);
  const transitionRafRef = useRef<number | null>(null);
  const transitionTimeoutRef = useRef<number | null>(null);
  const isInteractive = zoom >= 0.4;

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click
    
    // Always allow selection, regardless of zoom level
    onSelect(node.id);

    // Allow interaction with inputs/textareas without dragging hijacking it
    const target = e.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
      return;
    }

    // Only allow dragging if we are in interactive mode (zoomed in enough)
    if (isInteractive) {
      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      initialPositionRef.current = screenPosition;
      setDragOffset({ x: 0, y: 0 });
    }
  }, [node.id, onSelect, screenPosition, isInteractive]);

  // Handle messages from tabs (terminal input)
  const handleMessage = useCallback((content: string) => {
    onMessage?.(node.id, content);
  }, [node.id, onMessage]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDoubleClick?.(node.id);
  }, [node.id, onDoubleClick]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(node.id, e);
  }, [node.id, onContextMenu]);

  useEffect(() => {
    if (isDragging) {
      const handleMouseMove = (e: MouseEvent) => {
        if (!dragStartRef.current) return;
        
        const currentX = e.clientX;
        const currentY = e.clientY;
        const deltaX = currentX - (lastMousePosRef.current?.x ?? currentX);
        const deltaY = currentY - (lastMousePosRef.current?.y ?? currentY);
        
        lastMousePosRef.current = { x: currentX, y: currentY };

        setDragOffset({
          x: currentX - dragStartRef.current.x,
          y: currentY - dragStartRef.current.y,
        });

        // Pass raw screen delta for backend update (edges)
        // We use transient: true to avoid heavy syncs/saves
        // We do NOT snap during drag for smoothness
        onPositionChange(node.id, deltaX, deltaY, { snap: false, transient: true });
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        dragStartRef.current = null;
        lastMousePosRef.current = null;
        
        // Final snap: delta 0 means "use current position but apply snap"
        onPositionChange(node.id, 0, 0, { snap: true, transient: false });
        onPositionCommit?.(node.id);
        setDragOffset({ x: 0, y: 0 });
      };

      // Initialize last position on mount (or start of drag)
      lastMousePosRef.current = { x: dragStartRef.current!.x, y: dragStartRef.current!.y };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);

      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, node.id, onPositionChange, onPositionCommit]);

  // Detect mode changes (Overview <-> Detailed) for transition animation
  useLayoutEffect(() => {
    const wasOverview = previousOverviewRef.current;
    if (wasOverview === isOverview) return;

    // If going to overview, current size is full size
    if (!wasOverview) {
      fullSizeRef.current = size;
    } else {
      // Coming from overview
      overviewSizeRef.current = size;
    }

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


  const interactiveClass = isInteractive ? 'vuhlp-node-window--interactive' : '';
  const modeTransitionClass = transitionScale ? 'vuhlp-node-window--mode-transition' : '';

  // Cap the content scale to prevent text from getting too large when zoomed in
  // Window container still gets larger, but inner content stays readable
  const MAX_CONTENT_SCALE = 1.0;
  const contentZoom = Math.min(zoom, MAX_CONTENT_SCALE);

  // Check if window is at max size (using base/unscaled size)
  // Note: size prop is now unscaled model size
  const baseWidth = size.width;
  const baseHeight = size.height;

  // Calculate effective position (local override during drag)
  let effectivePosition = screenPosition;

  if (isDragging && initialPositionRef.current) {
    // Convert screen pixel delta to model unit delta
    effectivePosition = {
      x: initialPositionRef.current.x + dragOffset.x / zoom,
      y: initialPositionRef.current.y + dragOffset.y / zoom,
    };
  }

  // Position window with top-left at screenPosition
  // The parent layer is already transformed by pan/zoom
  const outerStyle: React.CSSProperties = {
    left: effectivePosition.x,
    top: effectivePosition.y,
    width: size.width,
    height: size.height,
    transform: transitionScale ? `scale(${transitionScale.x}, ${transitionScale.y})` : undefined,
    transformOrigin: 'center center',
  };

  // Inner content wrapper has BASE dimensions and uses transform to scale
  // Content uses contentZoom (capped) so text doesn't get too large when zoomed in far
  // The outer container still uses full zoom for sizing (via parent layer transform), giving more readable space
  // We need to invert the parent zoom for the content scale calculation relative to the outer container
  const contentWidth = baseWidth * (zoom / contentZoom);
  const contentHeight = baseHeight * (zoom / contentZoom);
  
  // In Overview, we want the content to appear larger relative to the scene (inverse zoom)
  // so it remains readable even when zoomed out.
  // We use a factor of 0.6 as a base readability scale for overview cards.
  const OVERVIEW_SCALE = 0.6;
  const overviewScale = OVERVIEW_SCALE / zoom;

  const innerStyle: React.CSSProperties = isOverview ? {
    width: size.width / overviewScale,
    height: size.height / overviewScale,
    transform: `scale(${overviewScale})`,
    transformOrigin: 'top left',
  } : {
    width: contentWidth,
    height: contentHeight,
    // Provide the content zoom relative to the parent's scale (which is `zoom`)
    transform: `scale(${contentZoom / zoom})`,
    transformOrigin: 'top left',
  };

  // Determine content to render
  const CustomContent = node.type ? NodeContentRegistry.get(node.type) : undefined;

  // Calculate summary text
  const getLastActivity = () => {
    if (!trackedState) return null;
    
    // Check for running tools first
    const runningTool = trackedState.tools.find(t => t.status === 'started');
    if (runningTool) {
      return `Running tool: ${runningTool.name}...`;
    }

    // Check for last user message
    const lastMsg = trackedState.messages[trackedState.messages.length - 1];
    if (lastMsg && lastMsg.type === 'assistant') {
      return lastMsg.content;
    }
    
    return null;
  };

  const summaryText = (node as any).summary || getLastActivity() || (
    node.status === 'queued' ? 'Waiting to start...' : 
    node.status === 'completed' ? 'Task completed.' :
    node.status === 'failed' ? 'Task failed.' : 
    'Ready'
  );

  return (
    <div
      ref={windowRef}
      className={`vuhlp-node-window ${interactiveClass} ${modeTransitionClass} ${isDimmed ? 'vuhlp-node-window--dimmed' : ''} vuhlp-node-window--status-${node.status} ${isSelected ? 'vuhlp-node-window--selected' : ''} ${isHighlighted ? 'vuhlp-node-window--highlighted' : ''} ${isDragging ? 'vuhlp-node-window--dragging' : ''} ${PROVIDER_CLASSES[node.providerId || 'mock'] || ''} ${isOverview ? 'vuhlp-node-window--overview' : ''} ${isFocused ? 'vuhlp-node-window--focused' : ''} ${size.width >= MAX_WINDOW_SIZE.width && size.height >= MAX_WINDOW_SIZE.height ? 'vuhlp-node-window--max-size' : ''}`}
      style={outerStyle}
      onMouseDown={handleDragStart}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      <div className="vuhlp-node-window__clip-mask">
        <div style={innerStyle} className="vuhlp-node-window__inner">
          {isOverview ? (
             <div className="vuhlp-node-window__compact-view">
                <div className="vuhlp-node-window__compact-header">
                  {node.providerId && (
                    <img 
                      src={`/${node.providerId}.svg`} 
                      alt={node.providerId}
                      className="vuhlp-node-window__compact-icon"
                    />
                  )}
                  <span className="vuhlp-node-window__compact-label">
                    {node.label || node.id.slice(0, 8)}
                  </span>
                  {node.durationMs !== undefined && (
                     <span className="vuhlp-node-window__compact-time">
                       {Math.round(node.durationMs / 1000)}s
                     </span>
                  )}
                </div>
                
                <div className="vuhlp-node-window__compact-body">
                   <div className={`vuhlp-node-window__compact-status vuhlp-node-window__status--${node.status}`}>
                     {node.status}
                   </div>
                   <div className="vuhlp-node-window__compact-summary">
                     {summaryText}
                   </div>
                </div>
             </div>
          ) : (
            <>
              <NodeWindowHeader
                node={node}
                onStop={() => onStopNode?.(node.id)}
                onRestart={() => onRestartNode?.(node.id)}
                onMouseDown={handleDragStart}
              />
              {CustomContent ? (
                <CustomContent node={node} trackedState={trackedState} />
              ) : (
                <NodeWindowTabs
                  node={node}
                  trackedState={trackedState}
                  onMessage={handleMessage}
                  isInteractive={isInteractive}
                  artifacts={artifacts}
                />
              )}
            </>
          )}
        </div>
      </div>
      
      {/* Port Handles */}
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
      <div
        className="vuhlp-node-port vuhlp-node-port--left"
        data-node-id={node.id}
        data-port="left"
        onMouseDown={(e) => {
          e.stopPropagation();
          onPortMouseDown?.(node.id, 'left', e);
        }}
        onClick={(e) => {
          e.stopPropagation();
          onPortClick?.(node.id, 'left', e);
        }}
      />
      <div
        className="vuhlp-node-port vuhlp-node-port--right"
        data-node-id={node.id}
        data-port="right"
        onMouseDown={(e) => {
          e.stopPropagation();
          onPortMouseDown?.(node.id, 'right', e);
        }}
        onClick={(e) => {
          e.stopPropagation();
          onPortClick?.(node.id, 'right', e);
        }}
      />
    </div>
  );
}
