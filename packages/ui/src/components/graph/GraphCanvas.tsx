import React, { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react';
import { Application, extend, useApplication } from '@pixi/react';
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

const pixiComponentsReady = {
  container: Boolean(PIXI.Container),
  graphics: Boolean(PIXI.Graphics),
  text: Boolean(PIXI.Text),
};

if (!pixiComponentsReady.container || !pixiComponentsReady.graphics || !pixiComponentsReady.text) {
  console.error('[graph] missing Pixi components for @pixi/react', pixiComponentsReady);
} else {
  extend({
    Container: PIXI.Container,
    Graphics: PIXI.Graphics,
    Text: PIXI.Text,
  });
}

type EdgePreview = {
  fromNodeId: string;
  fromPortIndex: number;
  to: { x: number; y: number };
};

type ClosestPort = {
  nodeId: string;
  portIndex: number;
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
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef(viewport);
  const nodesRef = useRef<VisualNode[]>(nodes);
  const edgesRef = useRef<VisualEdge[]>(edges);
  const previousViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastFocusStateRef = useRef<{ viewMode: string; nodeId: string | null; width: number; height: number } | null>(null);
  const dragStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const panStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const [edgePreview, setEdgePreview] = useState<EdgePreview | null>(null);
  const edgePreviewRef = useRef<EdgePreview | null>(null);
  const edgePreviewRafRef = useRef<number | null>(null);
  const dragRafRef = useRef<number | null>(null);
  const latestDragPointRef = useRef<{ x: number; y: number } | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<{ edgeId: string; x: number; y: number } | null>(null);
  const DRAG_THRESHOLD = 4;
  const EDGE_SNAP_RADIUS = 14;
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const deviceResolution = useMemo(() => {
    if (typeof window === 'undefined') return 1;
    return Math.min(window.devicePixelRatio || 1, 2);
  }, [dimensions.width, dimensions.height]);
  const renderKickKey = useMemo(
    () => `${nodes.length}:${edges.length}:${viewport.x}:${viewport.y}:${viewport.zoom}`,
    [nodes.length, edges.length, viewport.x, viewport.y, viewport.zoom]
  );
  
  // Interaction state
  const isPanning = useRef(false);
  const hasPanned = useRef(false);
  const hasDragged = useRef(false);
  const lastPanPosition = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Refs for imperative updates
  const domLayerRef = useRef<HTMLDivElement>(null);
  const pixiContainerRef = useRef<PIXI.Container>(null);

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
    
    // Sync refs with state when state changes (e.g. initial load, buttons, external updates)
    if (domLayerRef.current) {
      domLayerRef.current.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
    }
    if (pixiContainerRef.current) {
      pixiContainerRef.current.position.set(viewport.x, viewport.y);
      pixiContainerRef.current.scale.set(viewport.zoom);
    }
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

  const getCanvasPoint = useCallback((event: PointerEvent | WheelEvent | PIXI.FederatedPointerEvent) => {
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

      const node = nodesById.get(id);
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
    [getCanvasPoint, nodesById, viewMode]
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
    (point: { x: number; y: number }, ignorePort?: { nodeId: string; index: number }): ClosestPort | null => {
      let closest: ClosestPort | null = null;
      let closestDistance = Number.POSITIVE_INFINITY;
      nodesRef.current.forEach((node) => {
        for (const port of getNodePorts(node)) {
          if (ignorePort && node.id === ignorePort.nodeId && port.index === ignorePort.index) continue;
          const dx = point.x - port.x;
          const dy = point.y - port.y;
          const distance = Math.hypot(dx, dy);
          if (distance < closestDistance) {
            closestDistance = distance;
            closest = { nodeId: node.id, portIndex: port.index };
          }
        }
      });
      if (!closest || closestDistance > EDGE_SNAP_RADIUS) return null;
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

  const GraphRenderSync: React.FC<{ renderKey: string }> = ({ renderKey }) => {
    const { app, isInitialised } = useApplication();

    useLayoutEffect(() => {
      if (!isInitialised || !app.renderer || !app.stage) return;
      let rafId: number | null = null;
      try {
        app.renderer.render(app.stage);
        rafId = requestAnimationFrame(() => {
          try {
            if (!app.renderer || !app.stage) return;
            app.renderer.render(app.stage);
          } catch (error) {
            console.error('[graph] pixi render failed', error);
          }
        });
      } catch (error) {
        console.error('[graph] pixi render failed', error);
      }
      return () => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
      };
    }, [app, isInitialised, renderKey]);

    return null;
  };

  const scheduleEdgePreviewSync = useCallback(() => {
    if (edgePreviewRafRef.current !== null) return;
    edgePreviewRafRef.current = requestAnimationFrame(() => {
      edgePreviewRafRef.current = null;
      setEdgePreview(edgePreviewRef.current);
    });
  }, [setEdgePreview]);

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
    const node = nodesById.get(selectedNodeId);
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
  }, [viewMode, selectedNodeId, nodesById, dimensions, animateViewportTo]);

  useEffect(() => {
    if (viewMode !== 'fullscreen' || !selectedNodeId) return;
    if (animationRef.current) return;
    const node = nodesById.get(selectedNodeId);
    if (!node || !dimensions.width || !dimensions.height) return;
    const { fullZoom } = getFocusZoomLevels(node, dimensions);
    const targetViewport = getViewportForNode(node, dimensions, fullZoom);
    const dx = Math.abs(viewport.x - targetViewport.x);
    const dy = Math.abs(viewport.y - targetViewport.y);
    const dz = Math.abs(viewport.zoom - targetViewport.zoom);
    if (dx < 0.5 && dy < 0.5 && dz < 0.005) return;
    setViewport(targetViewport, false);
  }, [viewMode, selectedNodeId, nodesById, dimensions, viewport.x, viewport.y, viewport.zoom, setViewport]);

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
        const currentPreview = edgePreviewRef.current;
        if (!currentPreview) {
          console.warn('[graph] edge preview missing during drag', {
            fromNodeId: edgeDragRef.current.fromNodeId,
            fromPortIndex: edgeDragRef.current.fromPortIndex
          });
          return;
        }
        edgePreviewRef.current = { ...currentPreview, to: worldPoint };
        scheduleEdgePreviewSync();
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
        latestDragPointRef.current = { x: newX, y: newY };
        if (dragRafRef.current === null) {
          dragRafRef.current = requestAnimationFrame(() => {
            dragRafRef.current = null;
            const latest = latestDragPointRef.current;
            const nodeId = draggedNodeIdRef.current;
            if (!latest || !nodeId) return;
            updateNodePosition(nodeId, latest.x, latest.y);
          });
        }
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
        
        // Imperative update for zero latency
        const newX = viewportRef.current.x + dx;
        const newY = viewportRef.current.y + dy;
        const newZoom = viewportRef.current.zoom;

        if (domLayerRef.current) {
          domLayerRef.current.style.transform = `translate(${newX}px, ${newY}px) scale(${newZoom})`;
        }
        if (pixiContainerRef.current) {
          pixiContainerRef.current.position.set(newX, newY);
          pixiContainerRef.current.scale.set(newZoom);
        }

        const nextViewport = {
          ...viewportRef.current,
          x: newX,
          y: newY,
          zoom: newZoom
        };
        viewportRef.current = nextViewport;
        setViewport(nextViewport, false);
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
        if (edgePreviewRafRef.current !== null) {
          cancelAnimationFrame(edgePreviewRafRef.current);
          edgePreviewRafRef.current = null;
        }
        edgePreviewRef.current = null;
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
        if (dragRafRef.current !== null) {
          cancelAnimationFrame(dragRafRef.current);
          dragRafRef.current = null;
        }
        if (latestDragPointRef.current) {
          const latest = latestDragPointRef.current;
          updateNodePosition(draggedNodeIdRef.current, latest.x, latest.y);
          latestDragPointRef.current = null;
        }
        if (!hasDragged.current) {
          selectNode(draggedNodeIdRef.current);
        }
      } else if (isPanning.current && !hasPanned.current) {
        selectNode(null);
        setEdgeMenu(null);
      }
      if (isPanning.current && hasPanned.current) {
        setViewport(viewportRef.current, true);
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
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      if (edgePreviewRafRef.current !== null) {
        cancelAnimationFrame(edgePreviewRafRef.current);
        edgePreviewRafRef.current = null;
      }
      window.removeEventListener('pointermove', handleGlobalMove);
      window.removeEventListener('pointerup', handleGlobalUp);
      window.removeEventListener('pointercancel', handleGlobalUp);
    };
  }, [selectNode, setViewport, updateNodePosition, viewMode, getCanvasPoint, toWorldPoint, findClosestPort, addEdge, run, scheduleEdgePreviewSync]);

  // --- Zoom Handling ---
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (!canvasRef.current) return;
      if (viewMode === 'fullscreen') return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-graph-zoom-block]')) return;
      if (!canvasRef.current.contains(target)) return;
      const point = getCanvasPoint(e);
      if (!point) return;
      e.preventDefault();

      const scaleFactor = 1.1;
      const direction = e.deltaY > 0 ? 1 / scaleFactor : scaleFactor;
      const newZoom = Math.max(0.1, Math.min(viewportRef.current.zoom * direction, 6));

      // Zoom towards mouse pointer
      const newX = point.x - (point.x - viewportRef.current.x) * (newZoom / viewportRef.current.zoom);
      const newY = point.y - (point.y - viewportRef.current.y) * (newZoom / viewportRef.current.zoom);

      // Imperative update
      if (domLayerRef.current) {
        domLayerRef.current.style.transform = `translate(${newX}px, ${newY}px) scale(${newZoom})`;
      }
      if (pixiContainerRef.current) {
        pixiContainerRef.current.position.set(newX, newY);
        pixiContainerRef.current.scale.set(newZoom);
      }
      
      const nextViewport = { x: newX, y: newY, zoom: newZoom };
      viewportRef.current = nextViewport;

      setViewport(nextViewport, true);
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [getCanvasPoint, setViewport, viewMode]);

  const onPortPointerDown = (
    id: string,
    portIndex: number,
    event: React.PointerEvent<HTMLButtonElement>
  ) => {
    if (viewMode === 'fullscreen') return;
    setEdgeMenu(null);
    if (event?.preventDefault) event.preventDefault();
    if (event?.stopPropagation) event.stopPropagation();
    edgeDragRef.current = { fromNodeId: id, fromPortIndex: portIndex };
    const node = nodesById.get(id);
    if (!node) return;
    const port = getPortPosition(node, portIndex);
    if (!port) return;
    const preview = {
      fromNodeId: id,
      fromPortIndex: portIndex,
      to: { x: port.x, y: port.y }
    };
    edgePreviewRef.current = preview;
    setEdgePreview(preview);
    draggedNodeIdRef.current = null;
    isPanning.current = false;
    hasPanned.current = false;
    hasDragged.current = false;
    dragStartPointRef.current = null;
    panStartPointRef.current = null;
  };

  // --- Canvas Panning ---
  const onCanvasPointerDown = (event: PIXI.FederatedPointerEvent) => {
    if (viewMode === 'fullscreen') return;
    // Only pan if clicking on the background (draggedNodeId check is a backup)
    if (draggedNodeIdRef.current || edgeDragRef.current) return;
    setEdgeMenu(null);
    
    const point = getCanvasPoint(event);
    if (!point) return;
    isPanning.current = true;
    hasPanned.current = false;
    lastPanPosition.current = { x: point.x, y: point.y };
    panStartPointRef.current = point;
  };

  const drawBackground = useCallback((g: PIXI.Graphics) => {
    g.clear();
    // V8 might changes here, but try to use compatible API if possible or update
    g.rect(0, 0, Math.max(1, dimensions.width), Math.max(1, dimensions.height));
    g.fill({ color: 0x000000, alpha: 0.001 }); // Almost transparent for hit testing
    g.hitArea = new PIXI.Rectangle(0, 0, Math.max(1, dimensions.width), Math.max(1, dimensions.height));
  }, [dimensions]);

  const drawEdgePreview = useCallback(
    (g: PIXI.Graphics) => {
      g.clear();
      if (!edgePreview) return;
      const node = nodesById.get(edgePreview.fromNodeId);
      if (!node) return;
      const start = getPortPosition(node, edgePreview.fromPortIndex);
      if (!start) return;
      
      // V8 API: move to / line to still works but lineStyle is deprecated for stroke() or similar?
      // V7: g.lineStyle(...) ...
      // V8: g.moveTo(..).lineTo(..).stroke({ width: 2, color: 0x666666, alpha: 0.6 });
      
      g.beginPath();
      g.moveTo(start.x, start.y);
      g.lineTo(edgePreview.to.x, edgePreview.to.y);
      g.stroke({ width: 2, color: 0x666666, alpha: 0.6 });
    },
    [edgePreview, nodesById, getPortPosition]
  );

  return (
    <div
      ref={canvasRef}
      className="graph-canvas"
      style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <Application 
        width={Math.max(1, dimensions.width)} 
        height={Math.max(1, dimensions.height)} 
        backgroundAlpha={0}
        antialias={true}
        resolution={deviceResolution}
        autoStart={true}
        sharedTicker={true}
        eventMode="static"
      >
        <GraphRenderSync renderKey={renderKickKey} />
        <pixiGraphics
          draw={drawBackground}
          eventMode="static"
          onPointerDown={onCanvasPointerDown}
        />
        <pixiContainer 
          ref={pixiContainerRef}
          x={viewport.x} 
          y={viewport.y} 
          scale={{ x: viewport.zoom, y: viewport.zoom }}
        >
          {/* Draw Edges first */}
          {edges.map(edge => {
            const source = nodesById.get(edge.from);
            const target = nodesById.get(edge.to);
            if (source && target) {
              return (
                <GraphEdge 
                  key={edge.id} 
                  edge={edge} 
                  sourceNode={source} 
                  targetNode={target} 
                  resolution={deviceResolution}
                  onSelect={handleEdgeSelect}
                  onContextMenu={handleEdgeContextMenu}
                />
              );
            }
            return null;
          })}

          {edgePreview && <pixiGraphics draw={drawEdgePreview} eventMode="none" />}

          {/* Nodes are rendered in the DOM layer for richer interaction */}
        </pixiContainer>
      </Application>
      <GraphDomNodes
        ref={domLayerRef}
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
            title="Create new Agent(shift+n)"
          >
            <Plus width={20} height={20} />
            <span className="graph-canvas__control-label">New Agent</span>
          </button>
        )}
      </div>

      <GraphMinimap />
      <NodeFocusOverlay viewportSize={dimensions} />
    </div>
  );
};
