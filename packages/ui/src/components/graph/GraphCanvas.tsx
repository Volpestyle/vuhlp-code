import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Stage, Container, Graphics } from '@pixi/react';
import * as PIXI from 'pixi.js';
import { Plus, Minus } from 'iconoir-react';
import { useGraphStore } from '../../stores/graph-store';
import { useRunStore } from '../../stores/runStore';
import { getFocusZoomLevels, getViewportForNode } from '../../lib/graphFocus';
import { createEdge, deleteEdge } from '../../lib/api';
import type { VisualEdge, VisualNode } from '../../types/graph';
import { GraphEdge } from './GraphEdge';
import { GraphDomNodes } from './GraphDomNodes';
import { NodeFocusOverlay } from './NodeFocusOverlay';
import { GraphMinimap } from './GraphMinimap';
import './GraphCanvas.css';

type EdgePreview = {
  fromNodeId: string;
  fromPortIndex: number;
  to: { x: number; y: number };
};

interface GraphCanvasProps {
  onOpenNewNode?: () => void;
}

export const GraphCanvas: React.FC<GraphCanvasProps> = ({ onOpenNewNode }) => {
  const { nodes, edges, updateNodePosition, viewport, setViewport } = useGraphStore();
  const selectNode = useRunStore((s) => s.selectNode);
  const selectEdge = useRunStore((s) => s.selectEdge);
  const addEdge = useRunStore((s) => s.addEdge);
  const removeEdge = useRunStore((s) => s.removeEdge);
  const viewMode = useRunStore((s) => s.ui.viewMode);
  const selectedNodeId = useRunStore((s) => s.ui.selectedNodeId);
  const selectedEdgeId = useRunStore((s) => s.ui.selectedEdgeId);
  const run = useRunStore((s) => s.run);
  const draggedNodeIdRef = useRef<string | null>(null);
  const edgeDragRef = useRef<{ fromNodeId: string; fromPortIndex: number } | null>(null);
  const offsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dimensions, setDimensions] = useState({ width: window.innerWidth, height: window.innerHeight });
  const canvasRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef(viewport);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const previousViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastFocusStateRef = useRef<{ viewMode: string; nodeId: string | null; width: number; height: number } | null>(null);
  const dragStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const panStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const [edgePreview, setEdgePreview] = useState<EdgePreview | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<{ edgeId: string; x: number; y: number } | null>(null);
  const DRAG_THRESHOLD = 4;
  const EDGE_SNAP_RADIUS = 14;
  
  // Interaction state
  const isPanning = useRef(false);
  const hasPanned = useRef(false);
  const hasDragged = useRef(false);
  const lastPanPosition = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    if (!canvasRef.current) return;
    const element = canvasRef.current;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setDimensions({ width: rect.width, height: rect.height });
    };
    updateSize();
    const observer = new ResizeObserver(() => updateSize());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  useEffect(() => {
    if (viewMode === 'fullscreen') {
      setEdgeMenu(null);
    }
  }, [viewMode]);

  useEffect(() => {
    if (!edgeMenu) return;
    if (!selectedEdgeId || edgeMenu.edgeId !== selectedEdgeId) {
      setEdgeMenu(null);
    }
  }, [edgeMenu, selectedEdgeId]);

  const getPixiPoint = (event: any) => {
    const point = event?.data?.global ?? event?.global;
    return point ? { x: point.x, y: point.y } : null;
  };

  const getCanvasPoint = useCallback((event: PointerEvent | WheelEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const onNodePointerDown = useCallback(
    (id: string, event: React.PointerEvent<HTMLDivElement>) => {
      if (viewMode === 'fullscreen') return;
      event.preventDefault();
      event.stopPropagation();
      setEdgeMenu(null);

      draggedNodeIdRef.current = id;
      hasDragged.current = false;

      const node = nodes.find((item) => item.id === id);
      const point = getCanvasPoint(event.nativeEvent);
      if (point) {
        dragStartPointRef.current = point;
      }
      if (node && point) {
        const worldX = (point.x - viewportRef.current.x) / viewportRef.current.zoom;
        const worldY = (point.y - viewportRef.current.y) / viewportRef.current.zoom;
        offsetRef.current = {
          x: worldX - node.position.x,
          y: worldY - node.position.y,
        };
      }
    },
    [getCanvasPoint, nodes, viewMode]
  );

  const handleDeleteEdge = useCallback(
    (edgeId: string) => {
      if (!run) {
        removeEdge(edgeId);
        setEdgeMenu(null);
        return;
      }
      void deleteEdge(run.id, edgeId)
        .then(() => {
          removeEdge(edgeId);
          setEdgeMenu(null);
        })
        .catch((error) => {
          console.error('[graph] failed to delete edge', error);
        });
    },
    [run, removeEdge]
  );

  const handleEdgeSelect = useCallback(
    (edgeId: string) => {
      if (viewMode === 'fullscreen') return;
      selectEdge(edgeId);
      setEdgeMenu(null);
    },
    [selectEdge, viewMode]
  );

  const handleEdgeContextMenu = useCallback(
    (edgeId: string, event: PIXI.FederatedPointerEvent) => {
      if (viewMode === 'fullscreen') return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = 160;
      const menuHeight = 44;
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const maxX = Math.max(8, rect.width - menuWidth - 8);
      const maxY = Math.max(8, rect.height - menuHeight - 8);
      const clampedX = Math.min(Math.max(x, 8), maxX);
      const clampedY = Math.min(Math.max(y, 8), maxY);
      selectEdge(edgeId);
      setEdgeMenu({ edgeId, x: clampedX, y: clampedY });
    },
    [selectEdge, viewMode]
  );

  const toWorldPoint = useCallback((point: { x: number; y: number }) => {
    const { x, y, zoom } = viewportRef.current;
    return { x: (point.x - x) / zoom, y: (point.y - y) / zoom };
  }, []);

  const getNodePorts = useCallback((node: VisualNode) => {
    const { x, y } = node.position;
    const { width, height } = node.dimensions;
    return [
      { x: x + width / 2, y, index: 0 },
      { x: x + width, y: y + height / 2, index: 1 },
      { x: x + width / 2, y: y + height, index: 2 },
      { x, y: y + height / 2, index: 3 },
    ];
  }, []);

  const getPortPosition = useCallback(
    (node: VisualNode, portIndex: number) => getNodePorts(node).find((port) => port.index === portIndex) ?? null,
    [getNodePorts]
  );

  const findClosestPort = useCallback(
    (point: { x: number; y: number }, ignorePort?: { nodeId: string; index: number }) => {
      let closest: { nodeId: string; portIndex: number; distance: number } | null = null;
      nodesRef.current.forEach((node) => {
        for (const port of getNodePorts(node)) {
          if (ignorePort && node.id === ignorePort.nodeId && port.index === ignorePort.index) continue;
          const dx = point.x - port.x;
          const dy = point.y - port.y;
          const distance = Math.hypot(dx, dy);
          if (!closest || distance < closest.distance) {
            closest = { nodeId: node.id, portIndex: port.index, distance };
          }
        }
      });
      if (!closest) return null;
      if (closest.distance > EDGE_SNAP_RADIUS) return null;
      return closest;
    },
    [getNodePorts, EDGE_SNAP_RADIUS]
  );

  const animateViewportTo = useCallback(
    (target: { x: number; y: number; zoom: number }, persistAtEnd = true) => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      const start = { ...viewportRef.current };
      const duration = 420;
      const startTime = performance.now();
      const easeInOutCubic = (t: number) =>
        t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      const tick = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const eased = easeInOutCubic(progress);
        const nextViewport = {
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
          zoom: start.zoom + (target.zoom - start.zoom) * eased,
        };
        setViewport(nextViewport, false);
        if (progress < 1) {
          animationRef.current = requestAnimationFrame(tick);
        } else {
          setViewport(target, persistAtEnd);
          animationRef.current = null;
        }
      };

      animationRef.current = requestAnimationFrame(tick);
    },
    [setViewport]
  );

  useEffect(() => {
    if (viewMode !== 'fullscreen' || !selectedNodeId) {
      lastFocusStateRef.current = {
        viewMode,
        nodeId: selectedNodeId,
        width: dimensions.width,
        height: dimensions.height,
      };
      return;
    }
    const node = nodes.find((item) => item.id === selectedNodeId);
    if (!node || !dimensions.width || !dimensions.height) return;

    const lastFocus = lastFocusStateRef.current;
    const enteringFullscreen = lastFocus?.viewMode !== 'fullscreen';
    const nodeChanged = lastFocus?.nodeId !== selectedNodeId;
    const sizeChanged = lastFocus?.width !== dimensions.width || lastFocus?.height !== dimensions.height;

    if (enteringFullscreen || nodeChanged || sizeChanged) {
      if (!previousViewportRef.current) {
        previousViewportRef.current = viewportRef.current;
      }
      const { fullZoom } = getFocusZoomLevels(node, dimensions);
      const targetViewport = getViewportForNode(node, dimensions, fullZoom);
      animateViewportTo(targetViewport, false);
    }

    lastFocusStateRef.current = {
      viewMode,
      nodeId: selectedNodeId,
      width: dimensions.width,
      height: dimensions.height,
    };
  }, [viewMode, selectedNodeId, nodes, dimensions, animateViewportTo]);

  useEffect(() => {
    if (viewMode !== 'fullscreen' || !selectedNodeId) return;
    if (animationRef.current) return;
    const node = nodes.find((item) => item.id === selectedNodeId);
    if (!node || !dimensions.width || !dimensions.height) return;
    const { fullZoom } = getFocusZoomLevels(node, dimensions);
    const targetViewport = getViewportForNode(node, dimensions, fullZoom);
    const dx = Math.abs(viewport.x - targetViewport.x);
    const dy = Math.abs(viewport.y - targetViewport.y);
    const dz = Math.abs(viewport.zoom - targetViewport.zoom);
    if (dx < 0.5 && dy < 0.5 && dz < 0.005) return;
    setViewport(targetViewport, false);
  }, [viewMode, selectedNodeId, nodes, dimensions, viewport.x, viewport.y, viewport.zoom, setViewport]);

  useEffect(() => {
    if (viewMode === 'fullscreen') return;
    if (!previousViewportRef.current) return;
    const targetViewport = previousViewportRef.current;
    previousViewportRef.current = null;
    animateViewportTo(targetViewport, true);
  }, [viewMode, animateViewportTo]);

  useEffect(() => {
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  // Global pointer handlers to keep drag/pan active even when leaving the node.
  useEffect(() => {
    const handleGlobalMove = (event: PointerEvent) => {
      if (!draggedNodeIdRef.current && !isPanning.current && !edgeDragRef.current) return;
      const point = getCanvasPoint(event);
      if (!point) return;

      if (edgeDragRef.current) {
        const worldPoint = toWorldPoint(point);
        setEdgePreview((prev) => (prev ? { ...prev, to: worldPoint } : prev));
        return;
      }

      if (draggedNodeIdRef.current) {
        if (dragStartPointRef.current) {
          const dx = point.x - dragStartPointRef.current.x;
          const dy = point.y - dragStartPointRef.current.y;
          if (!hasDragged.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
            return;
          }
        }
        hasDragged.current = true;
        const { x: viewX, y: viewY, zoom } = viewportRef.current;
        const worldX = (point.x - viewX) / zoom;
        const worldY = (point.y - viewY) / zoom;
        const newX = worldX - offsetRef.current.x;
        const newY = worldY - offsetRef.current.y;
        updateNodePosition(draggedNodeIdRef.current, newX, newY);
        return;
      }

      if (isPanning.current) {
        if (panStartPointRef.current) {
          const dxFromStart = point.x - panStartPointRef.current.x;
          const dyFromStart = point.y - panStartPointRef.current.y;
          if (!hasPanned.current && Math.hypot(dxFromStart, dyFromStart) < DRAG_THRESHOLD) {
            return;
          }
          hasPanned.current = true;
        }

        const dx = point.x - lastPanPosition.current.x;
        const dy = point.y - lastPanPosition.current.y;
        const nextViewport = {
          ...viewportRef.current,
          x: viewportRef.current.x + dx,
          y: viewportRef.current.y + dy
        };
        viewportRef.current = nextViewport;
        setViewport(nextViewport, viewMode !== 'fullscreen');
        lastPanPosition.current = { x: point.x, y: point.y };
      }
    };

    const handleGlobalUp = (event: PointerEvent) => {
      if (edgeDragRef.current) {
        const point = getCanvasPoint(event);
        if (point) {
          const worldPoint = toWorldPoint(point);
          const target = findClosestPort(worldPoint, { nodeId: edgeDragRef.current.fromNodeId, index: edgeDragRef.current.fromPortIndex });
          if (target) {
            const edgeExists = edgesRef.current.some(
              (edge) =>
                (edge.from === edgeDragRef.current?.fromNodeId && edge.to === target.nodeId) ||
                (edge.bidirectional && edge.from === target.nodeId && edge.to === edgeDragRef.current?.fromNodeId)
            );
            if (!edgeExists) {
              const isSelfLoop = edgeDragRef.current.fromNodeId === target.nodeId;
              const newEdge: VisualEdge = {
                id: crypto.randomUUID(),
                from: edgeDragRef.current.fromNodeId,
                to: target.nodeId,
                bidirectional: !isSelfLoop,
                type: 'handoff',
                label: ''
              };
              if (run) {
                void createEdge(run.id, {
                  id: newEdge.id,
                  from: newEdge.from,
                  to: newEdge.to,
                  bidirectional: newEdge.bidirectional,
                  type: newEdge.type,
                  label: newEdge.label
                })
                  .then((created) => addEdge(created))
                  .catch((error) => {
                    console.error('[graph] failed to create edge', error);
                  });
              } else {
                addEdge(newEdge);
              }
            }
          }
        }
        edgeDragRef.current = null;
        setEdgePreview(null);
        isPanning.current = false;
        hasPanned.current = false;
        hasDragged.current = false;
        draggedNodeIdRef.current = null;
        dragStartPointRef.current = null;
        panStartPointRef.current = null;
        return;
      }

      if (draggedNodeIdRef.current) {
        if (!hasDragged.current) {
          selectNode(draggedNodeIdRef.current);
        }
      } else if (isPanning.current && !hasPanned.current) {
        selectNode(null);
        setEdgeMenu(null);
      }
      isPanning.current = false;
      hasPanned.current = false;
      hasDragged.current = false;
      draggedNodeIdRef.current = null;
      dragStartPointRef.current = null;
      panStartPointRef.current = null;
    };

    window.addEventListener('pointermove', handleGlobalMove);
    window.addEventListener('pointerup', handleGlobalUp);
    window.addEventListener('pointercancel', handleGlobalUp);
    return () => {
      window.removeEventListener('pointermove', handleGlobalMove);
      window.removeEventListener('pointerup', handleGlobalUp);
      window.removeEventListener('pointercancel', handleGlobalUp);
    };
  }, [selectNode, setViewport, updateNodePosition, viewMode, getCanvasPoint, toWorldPoint, findClosestPort, addEdge, run]);

  // --- Zoom Handling ---
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (!canvasRef.current) return;
      if (viewMode === 'fullscreen') return;
      const target = e.target as Element | null;
      if (target?.closest('[data-graph-zoom-block]')) return;
      if (target && !canvasRef.current.contains(target)) return;
      const point = getCanvasPoint(e);
      if (!point) return;
      e.preventDefault();

      const scaleFactor = 1.1;
      const direction = e.deltaY > 0 ? 1 / scaleFactor : scaleFactor;
      const newZoom = Math.max(0.1, Math.min(viewportRef.current.zoom * direction, 6));

      // Zoom towards mouse pointer
      const newX = point.x - (point.x - viewportRef.current.x) * (newZoom / viewportRef.current.zoom);
      const newY = point.y - (point.y - viewportRef.current.y) * (newZoom / viewportRef.current.zoom);

      setViewport({ x: newX, y: newY, zoom: newZoom }, viewMode !== 'fullscreen');
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [getCanvasPoint, setViewport, viewMode]);

  const onPortPointerDown = (id: string, portIndex: number, event: any) => {
    if (viewMode === 'fullscreen') return;
    setEdgeMenu(null);
    if (event?.preventDefault) event.preventDefault();
    if (event?.stopPropagation) event.stopPropagation();
    edgeDragRef.current = { fromNodeId: id, fromPortIndex: portIndex };
    const node = nodes.find(n => n.id === id);
    if (!node) return;
    const port = getPortPosition(node, portIndex);
    if (!port) return;
    setEdgePreview({
      fromNodeId: id,
      fromPortIndex: portIndex,
      to: { x: port.x, y: port.y }
    });
    draggedNodeIdRef.current = null;
    isPanning.current = false;
    hasPanned.current = false;
    hasDragged.current = false;
    dragStartPointRef.current = null;
    panStartPointRef.current = null;
  };

  // --- Canvas Panning ---
  const onCanvasPointerDown = (event: any) => {
    if (viewMode === 'fullscreen') return;
    // Only pan if clicking on the background (draggedNodeId check is a backup)
    if (draggedNodeIdRef.current || edgeDragRef.current) return;
    setEdgeMenu(null);
    
    const point = getPixiPoint(event);
    if (!point) return;
    isPanning.current = true;
    hasPanned.current = false;
    lastPanPosition.current = { x: point.x, y: point.y };
    panStartPointRef.current = point;
  };

  const drawBackground = (g: PIXI.Graphics) => {
    g.clear();
    g.beginFill(0x000000, 0);
    const safeWidth = Math.max(1, dimensions.width);
    const safeHeight = Math.max(1, dimensions.height);
    g.drawRect(0, 0, safeWidth, safeHeight);
    g.endFill();
    g.hitArea = new PIXI.Rectangle(0, 0, safeWidth, safeHeight);
  };

  const drawEdgePreview = useCallback(
    (g: PIXI.Graphics) => {
      g.clear();
      if (!edgePreview) return;
      const node = nodes.find((item) => item.id === edgePreview.fromNodeId);
      if (!node) return;
      const start = getPortPosition(node, edgePreview.fromPortIndex);
      if (!start) return;
      g.lineStyle(2, 0x666666, 0.6);
      g.moveTo(start.x, start.y);
      g.lineTo(edgePreview.to.x, edgePreview.to.y);
    },
    [edgePreview, nodes, getPortPosition]
  );

  return (
    <div
      ref={canvasRef}
      className="graph-canvas"
      style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <Stage 
        width={Math.max(1, dimensions.width)} 
        height={Math.max(1, dimensions.height)} 
        options={{ backgroundAlpha: 0, antialias: true, eventMode: 'static' }}
      >
        <Graphics
          draw={drawBackground}
          eventMode="static"
          pointerdown={onCanvasPointerDown}
        />
        <Container 
          x={viewport.x} 
          y={viewport.y} 
          scale={{ x: viewport.zoom, y: viewport.zoom }}
        >
          {/* Draw Edges first */}
          {edges.map(edge => {
            const source = nodes.find(n => n.id === edge.from);
            const target = nodes.find(n => n.id === edge.to);
            if (source && target) {
              return (
                <GraphEdge 
                  key={edge.id} 
                  edge={edge} 
                  sourceNode={source} 
                  targetNode={target} 
                  onSelect={handleEdgeSelect}
                  onContextMenu={handleEdgeContextMenu}
                />
              );
            }
            return null;
          })}

          {edgePreview && <Graphics draw={drawEdgePreview} eventMode="none" />}

          {/* Nodes are rendered in the DOM layer for richer interaction */}
        </Container>
      </Stage>
      <GraphDomNodes
        nodes={nodes}
        viewport={viewport}
        viewMode={viewMode}
        selectedNodeId={selectedNodeId}
        viewportSize={dimensions}
        onNodePointerDown={onNodePointerDown}
        onPortPointerDown={onPortPointerDown}
      />
      {edgeMenu && (
        <div
          className="graph-canvas__menu"
          style={{ left: edgeMenu.x, top: edgeMenu.y }}
        >
          <button
            className="graph-canvas__menu-button"
            type="button"
            onClick={() => handleDeleteEdge(edgeMenu.edgeId)}
          >
            Delete edge
          </button>
        </div>
      )}
      <div className="graph-canvas__zoom">
        <button
          className="graph-canvas__zoom-btn"
          onClick={() => setViewport({ ...viewport, zoom: Math.max(0.1, viewport.zoom / 1.1) }, viewMode !== 'fullscreen')}
          title="Zoom out (-)"
          disabled={viewMode === 'fullscreen'}
        >
          <Minus width={16} height={16} />
        </button>
        <div className="graph-canvas__zoom-value">
          {Math.round(viewport.zoom * 100)}%
        </div>
        <button
          className="graph-canvas__zoom-btn"
          onClick={() => setViewport({ ...viewport, zoom: Math.min(6, viewport.zoom * 1.1) }, viewMode !== 'fullscreen')}
          title="Zoom in (+)"
          disabled={viewMode === 'fullscreen'}
        >
          <Plus width={16} height={16} />
        </button>
      </div>

      
      {/* Graph Controls */}
      <div className="graph-canvas__controls">
        {onOpenNewNode && (
          <button
            className="graph-canvas__control-btn"
            onClick={onOpenNewNode}
            disabled={!run}
            title="Create new node (shift+n)"
          >
            <Plus width={20} height={20} />
            <span className="graph-canvas__control-label">New Node</span>
          </button>
        )}
      </div>

      <GraphMinimap />
      <NodeFocusOverlay viewportSize={dimensions} />
    </div>
  );
};
