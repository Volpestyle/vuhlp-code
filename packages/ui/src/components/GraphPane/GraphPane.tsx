import { useEffect, useRef, useCallback, useState, useMemo, type ChangeEvent } from 'react';
import cytoscape, { type Core, type EventObject } from 'cytoscape';
import type {
  Run,
  RunMode,
  RunPhase,
  InteractionMode,
  Node,
  NodeTrackedState,
  NodeStatus,
  Provider,
  Edge,
  EdgeType,
} from '../../types';
import { NodeWindow } from './NodeWindow';
import { useNodeWindowState, clearSavedWindowStates } from './useNodeWindowState';
import { useGraphFilters } from './useGraphFilters';
import {
  Position,
  Size,
  cyToScreen,
  centerToTopLeft,
  DEFAULT_WINDOW_SIZE,
  OVERVIEW_WINDOW_SIZE,
  SNAP_SIZE,
} from './coordinateUtils';
import './GraphPane.css';

// Storage key prefix for node positions
const POSITION_STORAGE_PREFIX = 'vuhlp-graph-positions-';
const OVERVIEW_ZOOM_THRESHOLD = 0.6;
const NEW_NODE_OFFSET_Y = 260;
const NEW_NODE_ORPHAN_OFFSET_X = 80;
const EDGE_HANDLE_RADIUS = 18;
const BASE_LAYOUT_OPTIONS = {
  name: 'breadthfirst',
  directed: true,
  padding: 200,
  spacingFactor: 2.5,
  orientation: 'vertical',
};

type ConnectionStyle = 'bezier' | 'taxi' | 'straight';

interface NodePosition {
  x: number;
  y: number;
}

interface SavedPositions {
  [nodeId: string]: NodePosition;
}

interface EdgeTooltipState {
  id: string;
  type: EdgeType;
  label: string;
  sourceLabel: string;
  targetLabel: string;
  x: number;
  y: number;
}

type EdgeEndpoint = 'source' | 'target';
type PortKind = 'input' | 'output';
type CyNodeCollection = ReturnType<Core['nodes']>;

interface EdgeDragState {
  edgeId: string;
  end: EdgeEndpoint;
  fixedPosition: Position;
  currentPosition: Position;
}

function getPositionStorageKey(runId: string): string {
  return `${POSITION_STORAGE_PREFIX}${runId}`;
}

function loadSavedPositions(runId: string): SavedPositions | null {
  try {
    const stored = localStorage.getItem(getPositionStorageKey(runId));
    if (stored) {
      return JSON.parse(stored) as SavedPositions;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function savePositions(runId: string, positions: SavedPositions): void {
  try {
    localStorage.setItem(getPositionStorageKey(runId), JSON.stringify(positions));
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

function clearSavedPositions(runId: string): void {
  try {
    localStorage.removeItem(getPositionStorageKey(runId));
  } catch {
    // Ignore storage errors
  }
}

function getFallbackPosition(nodeId: string, edges: Edge[], positions: SavedPositions): Position | null {
  // Try to position based on incoming edge (below source)
  for (const edge of edges) {
    if (edge.target === nodeId) {
      const sourcePos = positions[edge.source];
      if (sourcePos) {
        return { x: sourcePos.x, y: sourcePos.y + NEW_NODE_OFFSET_Y };
      }
    }
  }

  // Try to position based on outgoing edge (above target)
  for (const edge of edges) {
    if (edge.source === nodeId) {
      const targetPos = positions[edge.target];
      if (targetPos) {
        return { x: targetPos.x, y: targetPos.y - NEW_NODE_OFFSET_Y };
      }
    }
  }

  // Orphan node: position offset from the centroid of existing positioned nodes
  const positionValues = Object.values(positions);
  if (positionValues.length > 0) {
    // Calculate centroid
    let sumX = 0;
    let sumY = 0;
    for (const pos of positionValues) {
      sumX += pos.x;
      sumY += pos.y;
    }
    const centroidX = sumX / positionValues.length;
    const centroidY = sumY / positionValues.length;

    // Position below and slightly offset from the centroid
    return {
      x: centroidX + NEW_NODE_ORPHAN_OFFSET_X,
      y: centroidY + NEW_NODE_OFFSET_Y,
    };
  }

  return null;
}

function isEdgeType(value: unknown): value is EdgeType {
  return value === 'handoff'
    || value === 'dependency'
    || value === 'report'
    || value === 'gate';
}

function getPointerPosition(container: HTMLDivElement | null, evt: EventObject): Position | null {
  if (!container) return null;
  if (!evt.originalEvent) return null;
  if (!(evt.originalEvent instanceof MouseEvent)) return null;

  const rect = container.getBoundingClientRect();
  return {
    x: evt.originalEvent.clientX - rect.left,
    y: evt.originalEvent.clientY - rect.top,
  };
}

function getPointerPositionFromMouseEvent(container: HTMLDivElement | null, evt: MouseEvent): Position | null {
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  return {
    x: evt.clientX - rect.left,
    y: evt.clientY - rect.top,
  };
}

function getPortTargetFromPoint(clientX: number, clientY: number): { nodeId: string; port: PortKind } | null {
  const element = document.elementFromPoint(clientX, clientY);
  if (!(element instanceof HTMLElement)) return null;
  const portElement = element.closest('.vuhlp-node-port');
  if (!(portElement instanceof HTMLElement)) return null;
  const nodeId = portElement.dataset.nodeId;
  const port = portElement.dataset.port;
  if (!nodeId) return null;
  if (port !== 'input' && port !== 'output') return null;
  return { nodeId, port };
}

function distanceBetween(a: Position, b: Position): number {
  const deltaX = a.x - b.x;
  const deltaY = a.y - b.y;
  return Math.hypot(deltaX, deltaY);
}

function buildEdgePath(source: Position, target: Position, style: ConnectionStyle): string {
  if (style === 'straight') {
    return `M ${source.x} ${source.y} L ${target.x} ${target.y}`;
  }

  if (style === 'taxi') {
    const midY = (source.y + target.y) / 2;
    return `M ${source.x} ${source.y} L ${source.x} ${midY} L ${target.x} ${midY} L ${target.x} ${target.y}`;
  }

  const midY = (source.y + target.y) / 2;
  return `M ${source.x} ${source.y} C ${source.x} ${midY} ${target.x} ${midY} ${target.x} ${target.y}`;
}

function getCyPortPosition(cy: Core, nodeId: string, port: PortKind): Position | null {
  const element = cy.getElementById(nodeId);
  if (!('position' in element)) return null;

  const widthValue = element.data('width');
  const heightValue = element.data('height');
  const width = typeof widthValue === 'number' ? widthValue : DEFAULT_WINDOW_SIZE.width;
  const height = typeof heightValue === 'number' ? heightValue : DEFAULT_WINDOW_SIZE.height;

  const zoom = cy.zoom();
  const pan = cy.pan();
  const pos = element.position();
  const center = {
    x: pos.x * zoom + pan.x,
    y: pos.y * zoom + pan.y,
  };
  const scaledHeight = height * zoom;
  const yOffset = port === 'input' ? -scaledHeight / 2 : scaledHeight / 2;

  return {
    x: center.x,
    y: center.y + yOffset,
  };
}

function resolveRootNodes(
  cy: Core,
  edges: Edge[],
  rootOrchestratorNodeId: string | null | undefined
): CyNodeCollection | null {
  if (rootOrchestratorNodeId) {
    const rootNode = cy.nodes().filter((node) => node.id() === rootOrchestratorNodeId);
    if (rootNode.length > 0) {
      return rootNode;
    }
  }

  const incomingTargets = new Set(edges.map((edge) => edge.target));
  const rootCandidates = cy.nodes().filter((node) => !incomingTargets.has(node.id()));
  return rootCandidates.length > 0 ? rootCandidates : null;
}

function runGraphLayout(
  cy: Core,
  edges: Edge[],
  rootOrchestratorNodeId: string | null | undefined
): void {
  const roots = resolveRootNodes(cy, edges, rootOrchestratorNodeId);
  const layoutOptions = { ...BASE_LAYOUT_OPTIONS, ...(roots ? { roots } : {}) };
  cy.layout(layoutOptions).run();
}

export interface GraphPaneProps {
  run: Run | null;
  onNodeSelect: (nodeId: string | null) => void;
  selectedNodeId: string | null;
  onEdgeUpdate?: (edgeId: string, updates: { source?: string; target?: string }) => void;
  onEdgeCreate?: (sourceId: string, targetId: string) => void;
  onNodeCreate?: (providerId: string, label: string) => void;
  onStop: () => void;
  onPause: () => void;
  onResume: (feedback?: string) => void;
  interactionMode: InteractionMode;
  onInteractionModeChange: (mode: InteractionMode) => void;
  runMode: RunMode;
  onRunModeChange: (mode: RunMode) => void;
  runPhase: RunPhase | null;
  getNodeTrackedState: (runId: string, nodeId: string) => NodeTrackedState;
}

const STATUS_COLORS: Record<string, string> = {
  queued: '#71717a',
  running: '#3b82f6',
  completed: '#22c55e',
  failed: '#ef4444',
  skipped: '#64748b',
};

const PROVIDER_COLORS: Record<string, string> = {
  claude: '#f59e0b',
  codex: '#10b981',
  gemini: '#6366f1',
  mock: '#71717a',
};

const STATUS_OPTIONS: { value: NodeStatus; label: string }[] = [
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' },
];

const PROVIDER_OPTIONS: { value: Provider; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'mock', label: 'Mock' },
];

const EDGE_TYPE_LABELS: Record<EdgeType, string> = {
  handoff: 'Handoff',
  dependency: 'Dependency',
  report: 'Report',
  gate: 'Gate',
};

const EDGE_COLORS: Record<EdgeType, string> = {
  handoff: '#71717a',
  dependency: '#52525b',
  report: '#71717a',
  gate: '#f59e0b',
};

const EDGE_FOCUS_COLORS = {
  upstream: '#38bdf8',
  downstream: '#a7c7e7',
};

export function GraphPane({
  run,
  onNodeSelect,
  selectedNodeId,
  onEdgeUpdate,
  onEdgeCreate,
  onNodeCreate,
  onStop,
  onPause,
  onResume,
  interactionMode: _interactionMode,
  onInteractionModeChange: _onInteractionModeChange,
  runMode,
  onRunModeChange,
  runPhase,
  getNodeTrackedState,
}: GraphPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const runIdRef = useRef<string | null>(null);
  const savedPositionsRef = useRef<SavedPositions | null>(null);
  const nodeLabelRef = useRef<Record<string, string>>({});
  const lastFollowedNodeIdRef = useRef<string | null>(null);
  const syncRef = useRef<number | null>(null);
  const handoffTimerRef = useRef<number | null>(null);

  // Viewport state for coordinate transformations
  const [viewport, setViewport] = useState({ zoom: 1, pan: { x: 0, y: 0 } });
  
  // Graph visual settings
  const [connectionStyle, setConnectionStyle] = useState<ConnectionStyle>('bezier');
  const [legendCollapsed, setLegendCollapsed] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [followRunning, setFollowRunning] = useState(false);
  const [edgeTooltip, setEdgeTooltip] = useState<EdgeTooltipState | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [edgeDrag, setEdgeDrag] = useState<EdgeDragState | null>(null);
  const [newEdgeDrag, setNewEdgeDrag] = useState<{ sourceId: string; currentPosition: Position } | null>(null);

  // Node positions from Cytoscape (model coordinates)
  const [nodePositions, setNodePositions] = useState<Record<string, Position>>({});

  // Window sizes
  const { getWindowSize, updateWindowSize, resetWindowSizes } = useNodeWindowState(run?.id || null);

  const isOverview = viewport.zoom < OVERVIEW_ZOOM_THRESHOLD;

  const nodes = useMemo<Node[]>(() => (run?.nodes ? Object.values(run.nodes) : []), [run]);
  const edges = useMemo(() => (run?.edges ? Object.values(run.edges) : []), [run]);

  useEffect(() => {
    const labels: Record<string, string> = {};
    nodes.forEach((node) => {
      labels[node.id] = node.label || node.id.slice(0, 8);
    });
    nodeLabelRef.current = labels;
  }, [nodes]);

  const {
    searchQuery,
    setSearchQuery,
    selectedStatuses,
    selectedProviders,
    showFilters,
    setShowFilters,
    visibleNodes,
    visibleNodeIds,
    visibleEdgeIds,
    hasActiveFilters,
    toggleStatusFilter,
    toggleProviderFilter,
    clearFilters,
  } = useGraphFilters({ nodes, edges, runId: run?.id || null });

  const {
    focusNodeIds,
    upstreamEdgeIds,
    downstreamEdgeIds,
  } = useMemo(() => {
    if (!selectedNodeId) {
      return {
        focusNodeIds: new Set<string>(),
        upstreamEdgeIds: new Set<string>(),
        downstreamEdgeIds: new Set<string>(),
      };
    }

    const outgoing = new Map<string, Edge[]>();
    const incoming = new Map<string, Edge[]>();

    edges.forEach((edge) => {
      const outgoingEdges = outgoing.get(edge.source) || [];
      outgoingEdges.push(edge);
      outgoing.set(edge.source, outgoingEdges);

      const incomingEdges = incoming.get(edge.target) || [];
      incomingEdges.push(edge);
      incoming.set(edge.target, incomingEdges);
    });

    const upstreamNodes = new Set<string>();
    const downstreamNodes = new Set<string>();
    const upstreamEdges = new Set<string>();
    const downstreamEdges = new Set<string>();

    const upstreamQueue = [selectedNodeId];
    while (upstreamQueue.length > 0) {
      const current = upstreamQueue.shift();
      if (!current) continue;
      const incomingEdges = incoming.get(current) || [];
      incomingEdges.forEach((edge) => {
        upstreamEdges.add(edge.id);
        if (!upstreamNodes.has(edge.source)) {
          upstreamNodes.add(edge.source);
          upstreamQueue.push(edge.source);
        }
      });
    }

    const downstreamQueue = [selectedNodeId];
    while (downstreamQueue.length > 0) {
      const current = downstreamQueue.shift();
      if (!current) continue;
      const outgoingEdges = outgoing.get(current) || [];
      outgoingEdges.forEach((edge) => {
        downstreamEdges.add(edge.id);
        if (!downstreamNodes.has(edge.target)) {
          downstreamNodes.add(edge.target);
          downstreamQueue.push(edge.target);
        }
      });
    }

    const combinedNodes = new Set<string>([selectedNodeId, ...upstreamNodes, ...downstreamNodes]);

    return {
      focusNodeIds: combinedNodes,
      upstreamEdgeIds: upstreamEdges,
      downstreamEdgeIds: downstreamEdges,
    };
  }, [selectedNodeId, edges]);

  const runningNodeId = useMemo(() => {
    let latestNode: Node | null = null;
    for (const node of nodes) {
      if (node.status !== 'running' || !node.startedAt) continue;
      if (!latestNode) {
        latestNode = node;
        continue;
      }
      const currentTime = new Date(node.startedAt).getTime();
      const latestTime = new Date(latestNode.startedAt || 0).getTime();
      if (currentTime > latestTime) {
        latestNode = node;
      }
    }
    return latestNode ? latestNode.id : null;
  }, [nodes]);

  const getEffectiveWindowSize = useCallback((nodeId: string): Size => {
    if (isOverview) return OVERVIEW_WINDOW_SIZE;
    return getWindowSize(nodeId);
  }, [isOverview, getWindowSize]);

  const getScaledSize = useCallback((nodeId: string): Size => {
    const baseSize = getEffectiveWindowSize(nodeId);
    return {
      width: baseSize.width * viewport.zoom,
      height: baseSize.height * viewport.zoom,
    };
  }, [getEffectiveWindowSize, viewport.zoom]);

  const getScreenPosition = useCallback((nodeId: string, scaledSize: Size): Position => {
    const modelPos = nodePositions[nodeId];
    if (!modelPos) return { x: 0, y: 0 };
    const screenCenter = cyToScreen(modelPos, viewport);
    return centerToTopLeft(screenCenter, scaledSize);
  }, [nodePositions, viewport]);

  const getPortPosition = useCallback((nodeId: string, port: PortKind): Position | null => {
    const modelPos = nodePositions[nodeId];
    if (!modelPos) return null;
    const center = cyToScreen(modelPos, viewport);
    const scaledSize = getScaledSize(nodeId);
    const yOffset = port === 'input' ? -scaledSize.height / 2 : scaledSize.height / 2;
    return {
      x: center.x,
      y: center.y + yOffset,
    };
  }, [nodePositions, viewport, getScaledSize]);

  // Update node positions from Cytoscape
  const syncPositionsFromCy = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const positions: Record<string, Position> = {};
    cy.nodes().forEach((node) => {
      const pos = node.position();
      positions[node.id()] = { x: pos.x, y: pos.y };
    });
    setNodePositions(positions);

    // Also update viewport
    const currentPan = cy.pan();
    setViewport({
      zoom: cy.zoom(),
      pan: currentPan,
    });
  }, []);

  // Throttled sync for high-frequency events
  const throttledSync = useCallback(() => {
    if (syncRef.current) return;
    syncRef.current = requestAnimationFrame(() => {
      syncPositionsFromCy();
      syncRef.current = null;
    });
  }, [syncPositionsFromCy]);

  const handleEdgeMouseDown = useCallback((evt: EventObject) => {
    if (!('source' in evt.target)) return;
    const position = getPointerPosition(containerRef.current, evt);
    if (!position) return;

    const cy = cyRef.current;
    if (!cy) return;

    const edge = evt.target;
    const sourceId = edge.source().id();
    const targetId = edge.target().id();
    const sourcePort = getCyPortPosition(cy, sourceId, 'output');
    const targetPort = getCyPortPosition(cy, targetId, 'input');
    if (!sourcePort || !targetPort) return;

    const sourceDistance = distanceBetween(position, sourcePort);
    const targetDistance = distanceBetween(position, targetPort);
    if (sourceDistance > EDGE_HANDLE_RADIUS && targetDistance > EDGE_HANDLE_RADIUS) return;

    const end: EdgeEndpoint = sourceDistance <= targetDistance ? 'source' : 'target';
    const fixedPosition = end === 'source' ? targetPort : sourcePort;

    setEdgeDrag({
      edgeId: edge.id(),
      end,
      fixedPosition,
      currentPosition: position,
    });
    setEdgeTooltip(null);
    setHoveredEdgeId(edge.id());
  }, []);

  // Initialize Cytoscape
  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      autoungrabify: true, // Disable node dragging in Cytoscape (we handle it in HTML)
      autounselectify: true,
      userPanningEnabled: true,
      userZoomingEnabled: true,
      style: [
        {
          // Nodes serve as invisible anchors with correct dimensions for edge routing
          selector: 'node',
          style: {
            'background-opacity': 0,
            'border-width': 0,
            width: 'data(width)',
            height: 'data(height)',
            shape: 'round-rectangle',
            label: '',
          },
        },
        {
          selector: 'edge',
          style: {
            width: 2,
            'line-color': EDGE_COLORS.dependency,
            'target-arrow-color': EDGE_COLORS.dependency,
            'target-arrow-shape': 'triangle',
            'curve-style': connectionStyle,
            'taxi-direction': 'vertical',
            'taxi-turn': 20,
            'arrow-scale': 1,
            'opacity': 0.85,
            'source-endpoint': '0 1',
            'target-endpoint': '0 -1',
          },
        },
        {
          selector: 'edge[type="handoff"]',
          style: {
            'line-style': 'dashed',
            'line-color': EDGE_COLORS.handoff,
            'target-arrow-color': EDGE_COLORS.handoff,
            'line-dash-offset': 0,
          },
        },
        {
          selector: 'edge[type="report"]',
          style: {
            'line-style': 'dotted',
            'line-color': EDGE_COLORS.report,
            'target-arrow-color': EDGE_COLORS.report,
          },
        },
        {
          selector: 'edge[type="gate"]',
          style: {
            'line-color': EDGE_COLORS.gate,
            'target-arrow-color': EDGE_COLORS.gate,
          },
        },
        {
          selector: '.vuhlp-hidden',
          style: {
            display: 'none',
          },
        },
        {
          selector: 'edge.vuhlp-edge--dim',
          style: {
            opacity: 0.2,
          },
        },
        {
          selector: 'edge.vuhlp-edge--upstream',
          style: {
            'line-color': EDGE_FOCUS_COLORS.upstream,
            'target-arrow-color': EDGE_FOCUS_COLORS.upstream,
            width: 3,
            opacity: 1,
          },
        },
        {
          selector: 'edge.vuhlp-edge--downstream',
          style: {
            'line-color': EDGE_FOCUS_COLORS.downstream,
            'target-arrow-color': EDGE_FOCUS_COLORS.downstream,
            width: 3,
            opacity: 1,
          },
        },
        {
          selector: 'edge.vuhlp-edge--hover',
          style: {
            width: 3.5,
            opacity: 1,
          },
        },
      ],
      layout: { ...BASE_LAYOUT_OPTIONS },
      minZoom: 0.2,
      maxZoom: 2,
      wheelSensitivity: 0.3,
    });

    // Click on canvas to deselect
    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) {
        onNodeSelect(null);
        setHoveredEdgeId(null);
        setEdgeTooltip(null);
      }
    });

    // Sync positions when viewport changes (throttled)
    cy.on('pan zoom render', throttledSync);

    const handleEdgeOver = (evt: EventObject) => {
      if (!('source' in evt.target)) return;
      const position = getPointerPosition(containerRef.current, evt);
      if (!position) return;

      const edge = evt.target;
      const typeValue = edge.data('type');
      const type = isEdgeType(typeValue) ? typeValue : 'dependency';
      const labelValue = edge.data('label');
      const label = typeof labelValue === 'string' && labelValue.length > 0
        ? labelValue
        : EDGE_TYPE_LABELS[type];
      const sourceId = edge.source().id();
      const targetId = edge.target().id();
      const sourceLabel = nodeLabelRef.current[sourceId] || sourceId;
      const targetLabel = nodeLabelRef.current[targetId] || targetId;

      setHoveredEdgeId(edge.id());
      setEdgeTooltip({
        id: edge.id(),
        type,
        label,
        sourceLabel,
        targetLabel,
        x: position.x,
        y: position.y,
      });
    };

    const handleEdgeMove = (evt: EventObject) => {
      const position = getPointerPosition(containerRef.current, evt);
      if (!position) return;
      setEdgeTooltip((current) => (current ? { ...current, x: position.x, y: position.y } : current));
    };

    const handleEdgeOut = () => {
      setHoveredEdgeId(null);
      setEdgeTooltip(null);
    };

    cy.on('mouseover', 'edge', handleEdgeOver);
    cy.on('mousemove', 'edge', handleEdgeMove);
    cy.on('mouseout', 'edge', handleEdgeOut);
    cy.on('mousedown', 'edge', handleEdgeMouseDown);

    cyRef.current = cy;
    let offset = 0;
    handoffTimerRef.current = window.setInterval(() => {
      const activeCy = cyRef.current;
      if (!activeCy) return;
      offset = (offset - 2 + 20) % 20;
      activeCy.edges().filter((edge) => edge.data('type') === 'handoff').forEach((edge) => {
        edge.style('line-dash-offset', offset);
      });
    }, 120);

    return () => {
      if (syncRef.current) cancelAnimationFrame(syncRef.current);
      if (handoffTimerRef.current) {
        window.clearInterval(handoffTimerRef.current);
        handoffTimerRef.current = null;
      }
      cy.destroy();
    };
  }, [onNodeSelect, throttledSync, handleEdgeMouseDown]);

  // Update styles when connection style changes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    
    cy.style()
      .selector('edge')
      .style({
        'curve-style': connectionStyle,
        'source-endpoint': '0 1',
        'target-endpoint': '0 -1',
      })
      .update();
  }, [connectionStyle]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
      cy.nodes().forEach((node) => {
        if (visibleNodeIds.has(node.id())) {
          node.removeClass('vuhlp-hidden');
        } else {
          node.addClass('vuhlp-hidden');
        }
      });

      cy.edges().forEach((edge) => {
        const edgeId = edge.id();
        const isVisible = visibleEdgeIds.has(edgeId);
        if (isVisible) {
          edge.removeClass('vuhlp-hidden');
        } else {
          edge.addClass('vuhlp-hidden');
        }

        edge.removeClass('vuhlp-edge--dim vuhlp-edge--upstream vuhlp-edge--downstream vuhlp-edge--hover');

        if (!isVisible) return;

        if (hoveredEdgeId === edgeId) {
          edge.addClass('vuhlp-edge--hover');
        }

        if (selectedNodeId) {
          if (upstreamEdgeIds.has(edgeId)) {
            edge.addClass('vuhlp-edge--upstream');
          } else if (downstreamEdgeIds.has(edgeId)) {
            edge.addClass('vuhlp-edge--downstream');
          } else {
            edge.addClass('vuhlp-edge--dim');
          }
        }
      });
    });
  }, [
    visibleNodeIds,
    visibleEdgeIds,
    upstreamEdgeIds,
    downstreamEdgeIds,
    hoveredEdgeId,
    selectedNodeId,
  ]);

  useEffect(() => {
    if (!selectedNodeId) return;
    if (visibleNodeIds.has(selectedNodeId)) return;
    onNodeSelect(null);
  }, [selectedNodeId, visibleNodeIds, onNodeSelect]);

  useEffect(() => {
    if (!edgeTooltip) return;
    if (visibleEdgeIds.has(edgeTooltip.id)) return;
    setEdgeTooltip(null);
    setHoveredEdgeId(null);
  }, [edgeTooltip, visibleEdgeIds]);

  // Update graph when run changes (Incremental)
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    if (!run?.nodes) {
      cy.elements().remove();
      runIdRef.current = null;
      savedPositionsRef.current = null;
      setNodePositions({});
      return;
    }

    const isNewRun = runIdRef.current !== run.id;
    if (isNewRun) {
      runIdRef.current = run.id;
      savedPositionsRef.current = loadSavedPositions(run.id);
    }

    const storedPositions = savedPositionsRef.current || {};
    const currentPositions: SavedPositions = {};
    cy.nodes().forEach((node) => {
      const pos = node.position();
      currentPositions[node.id()] = { x: pos.x, y: pos.y };
    });

    const mergedPositions: SavedPositions = {
      ...storedPositions,
      ...currentPositions,
    };

    cy.batch(() => {
      const nodeIdSet = new Set(nodes.map((node) => node.id));
      const edgeIdSet = new Set(edges.map((edge) => edge.id));

      const selectorsToRemove: string[] = [];
      cy.nodes().forEach((node) => {
        if (!nodeIdSet.has(node.id())) {
          selectorsToRemove.push(`#${node.id()}`);
        }
      });
      cy.edges().forEach((edge) => {
        if (!edgeIdSet.has(edge.id())) {
          selectorsToRemove.push(`#${edge.id()}`);
        }
      });
      if (selectorsToRemove.length > 0) {
        cy.remove(selectorsToRemove.join(','));
      }

      nodes.forEach((node) => {
        const size = getEffectiveWindowSize(node.id);
        const existing = cy.nodes().filter((currentNode) => currentNode.id() === node.id);

        if (existing.length > 0) {
          existing.forEach((currentNode) => {
            currentNode.data({ width: size.width, height: size.height });
          });
          return;
        }

        const fallbackPosition = mergedPositions[node.id]
          || getFallbackPosition(node.id, edges, mergedPositions);

        cy.add({
          data: {
            id: node.id,
            width: size.width,
            height: size.height,
          },
          ...(fallbackPosition ? { position: fallbackPosition } : {}),
          grabbable: false,
        });
      });

      edges.forEach((edge) => {
        const existing = cy.edges().filter((currentEdge) => currentEdge.id() === edge.id);
        const data = {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: edge.type,
          ...(edge.label ? { label: edge.label } : {}),
        };

        if (existing.length > 0) {
          let shouldRecreate = false;
          existing.forEach((currentEdge) => {
            const currentSource = currentEdge.source().id();
            const currentTarget = currentEdge.target().id();
            if (currentSource !== edge.source || currentTarget !== edge.target) {
              shouldRecreate = true;
            }
          });

          if (shouldRecreate) {
            cy.remove(`#${edge.id}`);
            cy.add({ data });
          } else {
            existing.forEach((currentEdge) => {
              currentEdge.data(data);
            });
          }
          return;
        }

        cy.add({ data });
      });
    });

    if (isNewRun) {
      const hasPositions = nodes.some((node) => mergedPositions[node.id]);
      if (!hasPositions) {
        runGraphLayout(cy, edges, run.rootOrchestratorNodeId ?? null);
      }
      cy.fit(undefined, 100);
      syncPositionsFromCy(); // Sync immediately after fit
      setTimeout(() => syncPositionsFromCy(), 50); // Also sync after animation settles
      return;
    }

    throttledSync();
  }, [run, nodes, edges, getEffectiveWindowSize, syncPositionsFromCy, throttledSync]);

  useEffect(() => {
    if (!followRunning) {
      lastFollowedNodeIdRef.current = null;
      return;
    }
    if (!runningNodeId || selectedNodeId) return;
    if (!visibleNodeIds.has(runningNodeId)) return;
    if (lastFollowedNodeIdRef.current === runningNodeId) return;

    lastFollowedNodeIdRef.current = runningNodeId;
    const cy = cyRef.current;
    if (!cy) return;

    cy.fit(cy.getElementById(runningNodeId), 120);
  }, [followRunning, runningNodeId, selectedNodeId, visibleNodeIds]);

  useEffect(() => {
    if (!newEdgeDrag) return;

    const handleMouseMove = (evt: MouseEvent) => {
      const position = getPointerPositionFromMouseEvent(containerRef.current, evt);
      if (!position) return;

      const target = getPortTargetFromPoint(evt.clientX, evt.clientY);
      // Snap to input port if hovering over one
      if (target && target.port === 'input') {
         const targetPosition = getPortPosition(target.nodeId, 'input');
         if (targetPosition) {
            setNewEdgeDrag(prev => prev ? { ...prev, currentPosition: targetPosition } : prev);
            return;
         }
      }

      setNewEdgeDrag(prev => prev ? { ...prev, currentPosition: position } : prev);
    };

    const handleMouseUp = (evt: MouseEvent) => {
      const target = getPortTargetFromPoint(evt.clientX, evt.clientY);
      if (target && target.port === 'input' && onEdgeCreate) {
        onEdgeCreate(newEdgeDrag.sourceId, target.nodeId);
      }
      setNewEdgeDrag(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [newEdgeDrag, getPortPosition, onEdgeCreate]);

  useEffect(() => {
    if (!edgeDrag) return;

    const isValidDrop = (end: EdgeEndpoint, port: PortKind) => {
      if (end === 'source') return port === 'output';
      return port === 'input';
    };

    const handleMouseMove = (evt: MouseEvent) => {
      const position = getPointerPositionFromMouseEvent(containerRef.current, evt);
      if (!position) return;

      const target = getPortTargetFromPoint(evt.clientX, evt.clientY);
      if (target && isValidDrop(edgeDrag.end, target.port)) {
        const targetPosition = getPortPosition(target.nodeId, target.port);
        if (targetPosition) {
          setEdgeDrag((current) => (current ? {
            ...current,
            currentPosition: targetPosition,
          } : current));
          return;
        }
      }

      setEdgeDrag((current) => (current ? {
        ...current,
        currentPosition: position,
      } : current));
    };

    const handleMouseUp = (evt: MouseEvent) => {
      const target = getPortTargetFromPoint(evt.clientX, evt.clientY);
      if (target && isValidDrop(edgeDrag.end, target.port)) {
        if (edgeDrag.end === 'source') {
          onEdgeUpdate?.(edgeDrag.edgeId, { source: target.nodeId });
        } else {
          onEdgeUpdate?.(edgeDrag.edgeId, { target: target.nodeId });
        }
      }
      setEdgeDrag(null);
      setHoveredEdgeId(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [edgeDrag, getPortPosition, onEdgeUpdate]);

  // Handle window position change (from drag)
  const handlePositionChange = useCallback((
    nodeId: string,
    deltaX: number,
    deltaY: number,
    options?: { snap?: boolean }
  ) => {
    const cy = cyRef.current;
    if (!cy) return;

    const shouldSnap = options?.snap ?? true;
    let updated = false;
    cy.nodes().forEach((node) => {
      if (node.id() === nodeId && !updated) {
        updated = true;
        const zoom = cy.zoom();
        const modelDeltaX = deltaX / zoom;
        const modelDeltaY = deltaY / zoom;
        const currentPos = node.position();
        let newX = currentPos.x + modelDeltaX;
        let newY = currentPos.y + modelDeltaY;
        if (shouldSnap) {
          newX = Math.round(newX / SNAP_SIZE) * SNAP_SIZE;
          newY = Math.round(newY / SNAP_SIZE) * SNAP_SIZE;
        }
        node.position({ x: newX, y: newY });
      }
    });

    if (!updated) return;

    const runId = runIdRef.current;
    if (runId) {
      const positions: SavedPositions = {};
      cy.nodes().forEach((n) => {
        const pos = n.position();
        positions[n.id()] = { x: pos.x, y: pos.y };
      });
      savePositions(runId, positions);
      savedPositionsRef.current = positions;
    }

    throttledSync();
  }, [throttledSync]);

  const handlePositionCommit = useCallback((nodeId: string) => {
    const cy = cyRef.current;
    if (!cy) return;

    const element = cy.getElementById(nodeId);
    if (!('position' in element)) return;

    syncPositionsFromCy();

    const runId = runIdRef.current;
    if (!runId) return;

    const positions: SavedPositions = {};
    cy.nodes().forEach((node) => {
      const pos = node.position();
      positions[node.id()] = { x: pos.x, y: pos.y };
    });
    savePositions(runId, positions);
    savedPositionsRef.current = positions;
  }, [syncPositionsFromCy]);

  // Handle window size change
  const handleSizeChange = useCallback((nodeId: string, size: Size) => {
    if (isOverview) return;
    updateWindowSize(nodeId, size);
    const cy = cyRef.current;
    if (cy) {
      const node = cy.getElementById(nodeId);
      if ('position' in node) {
        node.data({
          width: size.width,
          height: size.height,
        });
      }
    }
  }, [isOverview, updateWindowSize]);

  // Handle window select
  const handleWindowSelect = useCallback((nodeId: string) => {
    onNodeSelect(nodeId);
  }, [onNodeSelect]);

  const handleConnectionStyleChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    if (value === 'bezier' || value === 'taxi' || value === 'straight') {
      setConnectionStyle(value);
    }
  }, []);

  const handlePortMouseDown = useCallback((nodeId: string, port: 'input' | 'output', e: React.MouseEvent) => {
    // Only allow dragging from output ports to start a new connection
    if (port !== 'output') return;
    
    const position = getPointerPositionFromMouseEvent(containerRef.current, e.nativeEvent);
    if (!position) return;

    setNewEdgeDrag({
      sourceId: nodeId,
      currentPosition: position,
    });
    // Deselect potentially selected node to avoid dragging it
    if (selectedNodeId) onNodeSelect(null);
  }, [onNodeSelect, selectedNodeId]);

  const handleZoomIn = useCallback(() => {
    cyRef.current?.zoom(cyRef.current.zoom() * 1.2);
  }, []);

  const handleZoomOut = useCallback(() => {
    cyRef.current?.zoom(cyRef.current.zoom() / 1.2);
  }, []);

  const handleFit = useCallback(() => {
    cyRef.current?.fit(undefined, 100);
  }, []);
  
  const handleCenterSelection = useCallback(() => {
      if (selectedNodeId) {
          cyRef.current?.fit(cyRef.current.getElementById(selectedNodeId), 50);
      }
  }, [selectedNodeId]);

  const handleResetLayout = useCallback(() => {
    const cy = cyRef.current;
    const runId = runIdRef.current;
    if (!cy || !runId) return;

    clearSavedPositions(runId);
    clearSavedWindowStates(runId);
    resetWindowSizes();
    savedPositionsRef.current = null;

    const rootNodeId = run?.rootOrchestratorNodeId ?? null;
    runGraphLayout(cy, edges, rootNodeId);

    cy.fit(undefined, 100);
    syncPositionsFromCy(); // Sync immediately after fit
    setTimeout(() => {
      syncPositionsFromCy();
    }, 50); // Also sync after animation settles
  }, [edges, resetWindowSizes, run?.rootOrchestratorNodeId, syncPositionsFromCy]);

  const isRunning = run?.status === 'running';
  const isPaused = run?.status === 'paused';
  const canControl = isRunning || isPaused;
  const edgeDragPoints = edgeDrag
    ? {
        source: edgeDrag.end === 'source' ? edgeDrag.currentPosition : edgeDrag.fixedPosition,
        target: edgeDrag.end === 'source' ? edgeDrag.fixedPosition : edgeDrag.currentPosition,
      }
    : null;

  return (
    <div className="vuhlp-graph">
      {/* Toolbar */}
      <div className="vuhlp-graph__toolbar">
        <div className="vuhlp-graph__info">
          {run ? (
            <>
              <span className={`vuhlp-graph__status vuhlp-graph__status--${run.status}`}>
                {run.status}
              </span>
              {runPhase && (
                <span className="vuhlp-graph__phase">{runPhase}</span>
              )}
              {nodes.length > 0 && (
                <span className="vuhlp-graph__count">
                  {visibleNodes.length}/{nodes.length} nodes
                </span>
              )}
            </>
          ) : (
            <span className="vuhlp-graph__empty-hint">Select a session to view graph</span>
          )}
        </div>

        <div className="vuhlp-graph__controls">
          {run && (
            <div className="vuhlp-graph__filters">
              <div className="vuhlp-graph__search">
                <input
                  type="search"
                  placeholder="Search nodes..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="vuhlp-graph__search-input"
                />
                {searchQuery && (
                  <button className="vuhlp-graph__search-clear" onClick={() => setSearchQuery('')} type="button">
                    Clear
                  </button>
                )}
              </div>

              <div className="vuhlp-graph__filter">
                <button
                  className={`vuhlp-graph__filter-btn ${showFilters ? 'vuhlp-graph__filter-btn--active' : ''}`}
                  onClick={() => setShowFilters((prev) => !prev)}
                  title="Filters"
                  type="button"
                >
                  Filters
                </button>
                {hasActiveFilters && (
                  <span className="vuhlp-graph__filter-count">
                    {visibleNodes.length}/{nodes.length}
                  </span>
                )}

                {showFilters && (
                  <div className="vuhlp-graph__filter-panel">
                    <div className="vuhlp-graph__filter-section">
                      <span className="vuhlp-graph__filter-title">Status</span>
                      <div className="vuhlp-graph__filter-chips">
                        {STATUS_OPTIONS.map((option) => (
                          <button
                            key={option.value}
                            className={`vuhlp-graph__filter-chip ${selectedStatuses.includes(option.value) ? 'vuhlp-graph__filter-chip--active' : ''}`}
                            onClick={() => toggleStatusFilter(option.value)}
                            type="button"
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="vuhlp-graph__filter-section">
                      <span className="vuhlp-graph__filter-title">Provider</span>
                      <div className="vuhlp-graph__filter-chips">
                        {PROVIDER_OPTIONS.map((option) => (
                          <button
                            key={option.value}
                            className={`vuhlp-graph__filter-chip ${selectedProviders.includes(option.value) ? 'vuhlp-graph__filter-chip--active' : ''}`}
                            onClick={() => toggleProviderFilter(option.value)}
                            type="button"
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="vuhlp-graph__filter-actions">
                      <button
                        className="vuhlp-graph__filter-clear"
                        onClick={clearFilters}
                        disabled={!hasActiveFilters}
                        type="button"
                      >
                        Clear
                      </button>
                      <span className="vuhlp-graph__filter-summary">
                        {visibleNodes.length}/{nodes.length} nodes
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="vuhlp-graph__style-select">
            <select
              value={connectionStyle}
              onChange={handleConnectionStyleChange}
              className="vuhlp-graph__select"
            >
              <option value="bezier">Bezier</option>
              <option value="taxi">Taxi</option>
              <option value="straight">Straight</option>
            </select>
          </div>

          {/* Mode Toggle */}
          {run && (
            <div className="vuhlp-graph__mode-toggle">
              <button
                className={`vuhlp-graph__mode-btn ${runMode === 'AUTO' ? 'vuhlp-graph__mode-btn--active' : ''}`}
                onClick={() => onRunModeChange('AUTO')}
              >
                Auto
              </button>
              <button
                className={`vuhlp-graph__mode-btn ${runMode === 'INTERACTIVE' ? 'vuhlp-graph__mode-btn--active' : ''}`}
                onClick={() => onRunModeChange('INTERACTIVE')}
              >
                Interactive
              </button>
            </div>
          )}

          {/* Add Node Button */}
          {run && onNodeCreate && (
             <button
                className="vuhlp-graph__control-btn"
                onClick={() => onNodeCreate('mock', 'New Agent')} // Default to mock for now
                title="Add Agent Node"
                style={{ marginLeft: 8 }}
              >
                <svg viewBox="0 0 16 16" fill="currentColor">
                   <path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2Z"/>
                </svg>
             </button>
          )}

          {/* Run Controls */}
          {canControl && (
            <div className="vuhlp-graph__run-controls">
              {isRunning && (
                <button
                  className="vuhlp-graph__control-btn vuhlp-graph__control-btn--pause"
                  onClick={onPause}
                  title="Pause"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <rect x="3" y="2" width="4" height="12" rx="1" />
                    <rect x="9" y="2" width="4" height="12" rx="1" />
                  </svg>
                </button>
              )}
              {isPaused && (
                <button
                  className="vuhlp-graph__control-btn vuhlp-graph__control-btn--resume"
                  onClick={() => onResume()}
                  title="Resume"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 2.5a.5.5 0 0 1 .8-.4l8 6a.5.5 0 0 1 0 .8l-8 6a.5.5 0 0 1-.8-.4v-12z" />
                  </svg>
                </button>
              )}
              <button
                className="vuhlp-graph__control-btn vuhlp-graph__control-btn--stop"
                onClick={onStop}
                title="Stop"
              >
                <svg viewBox="0 0 16 16" fill="currentColor">
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                </svg>
              </button>
            </div>
          )}

          {/* Zoom Controls */}
          <div className="vuhlp-graph__zoom-controls">
            <span className="vuhlp-graph__zoom-level" title="Current zoom level">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="7" cy="7" r="4" />
                <path d="M10 10l3 3" strokeLinecap="round" />
              </svg>
              {Math.round(viewport.zoom * 100)}%
            </span>
            <button className="vuhlp-graph__zoom-btn" onClick={handleZoomOut} title="Zoom out">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 8h8" strokeLinecap="round" />
              </svg>
            </button>
            <button className="vuhlp-graph__zoom-btn" onClick={handleFit} title="Fit to view">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2" y="2" width="12" height="12" rx="1" />
                <path d="M5 8h6M8 5v6" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className={`vuhlp-graph__zoom-btn ${showGrid ? 'vuhlp-graph__zoom-btn--active' : ''}`}
              onClick={() => setShowGrid((prev) => !prev)}
              title="Toggle grid"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 5h12M2 11h12M5 2v12M11 2v12" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className={`vuhlp-graph__zoom-btn ${followRunning ? 'vuhlp-graph__zoom-btn--active' : ''}`}
              onClick={() => setFollowRunning((prev) => !prev)}
              title="Follow running node"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="8" cy="8" r="3" />
                <path d="M8 1.5v2.5M8 12v2.5M1.5 8h2.5M12 8h2.5" strokeLinecap="round" />
              </svg>
            </button>
             {selectedNodeId && (
                 <button className="vuhlp-graph__zoom-btn" onClick={handleCenterSelection} title="Center selection">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M8 8m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
                        <path d="M8 2v2M8 12v2M2 8h2M12 8h2" />
                    </svg>
                 </button>
             )}
            <button className="vuhlp-graph__zoom-btn" onClick={handleZoomIn} title="Zoom in">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 8h8M8 4v8" strokeLinecap="round" />
              </svg>
            </button>
            {run && (
              <button className="vuhlp-graph__zoom-btn" onClick={handleResetLayout} title="Reset layout">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Graph Container - Canvas for edges */}
      <div className={`vuhlp-graph__canvas-container ${showGrid ? 'vuhlp-graph__canvas-container--grid' : ''}`}>
        <div ref={containerRef} className="vuhlp-graph__canvas" />

        {/* Windows Layer - HTML nodes on top of canvas */}
        {run && run.nodes && (
          <div className="vuhlp-graph__windows-layer">
            {visibleNodes.map((node: Node) => {
              const scaledSize = getScaledSize(node.id);
              const screenPos = getScreenPosition(node.id, scaledSize);
              const trackedState = getNodeTrackedState(run.id, node.id);
              const isDimmed = selectedNodeId ? !focusNodeIds.has(node.id) : false;

              return (
                <NodeWindow
                  key={node.id}
                  node={node}
                  trackedState={trackedState}
                  screenPosition={screenPos}
                  size={scaledSize}
                  isSelected={selectedNodeId === node.id}
                  isDimmed={isDimmed}
                  isOverview={isOverview}
                  onPositionChange={handlePositionChange}
                  onPositionCommit={handlePositionCommit}
                  onSizeChange={handleSizeChange}
                  onSelect={handleWindowSelect}
                  onPortMouseDown={handlePortMouseDown}
                  zoom={viewport.zoom}
                />
              );
            })}
          </div>
        )}

        {newEdgeDrag && (() => {
          const sourcePort = getPortPosition(newEdgeDrag.sourceId, 'output');
          if (!sourcePort) return null;
          return (
            <svg className="vuhlp-graph__edge-drag-layer" aria-hidden="true">
              <defs>
                 <marker
                  id="vuhlp-edge-drag-arrow-new"
                  markerWidth="8"
                  markerHeight="6"
                  refX="7"
                  refY="3"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M0,0 L8,3 L0,6 Z" fill="currentColor" />
                </marker>
              </defs>
              <path
                className="vuhlp-graph__edge-drag"
                d={buildEdgePath(sourcePort, newEdgeDrag.currentPosition, connectionStyle)}
                markerEnd="url(#vuhlp-edge-drag-arrow-new)"
                style={{ strokeDasharray: '5, 5' }}
              />
            </svg>
          );
        })()}

        {edgeDragPoints && (
          <svg className="vuhlp-graph__edge-drag-layer" aria-hidden="true">
            <defs>
              <marker
                id="vuhlp-edge-drag-arrow"
                markerWidth="8"
                markerHeight="6"
                refX="7"
                refY="3"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M0,0 L8,3 L0,6 Z" fill="currentColor" />
              </marker>
            </defs>
            <path
              className="vuhlp-graph__edge-drag"
              d={buildEdgePath(edgeDragPoints.source, edgeDragPoints.target, connectionStyle)}
              markerEnd="url(#vuhlp-edge-drag-arrow)"
            />
          </svg>
        )}

        {edgeTooltip && (
          <div
            className="vuhlp-graph__edge-tooltip"
            style={{ left: edgeTooltip.x + 12, top: edgeTooltip.y + 12 }}
          >
            <div className="vuhlp-graph__edge-tooltip-title">{edgeTooltip.label}</div>
            <div className="vuhlp-graph__edge-tooltip-meta">
              {edgeTooltip.sourceLabel} -&gt; {edgeTooltip.targetLabel}
            </div>
          </div>
        )}
      </div>

      {/* Empty State */}
      {!run && (
        <div className="vuhlp-graph__empty">
          <div className="vuhlp-graph__empty-icon">
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="4" />
              <circle cx="36" cy="12" r="4" />
              <circle cx="24" cy="36" r="4" />
              <path d="M15 14l6 18M33 14l-6 18" strokeLinecap="round" />
            </svg>
          </div>
          <p>Create a session to start orchestration</p>
        </div>
      )}

      {/* Legend */}
      {run && (
        <div className={`vuhlp-graph__legend ${legendCollapsed ? 'vuhlp-graph__legend--collapsed' : ''}`}>
          <button
            className="vuhlp-graph__legend-toggle"
            onClick={() => setLegendCollapsed((prev) => !prev)}
            title={legendCollapsed ? 'Show legend' : 'Hide legend'}
            type="button"
          >
            {legendCollapsed ? 'Legend' : 'Hide'}
          </button>

          {!legendCollapsed && (
            <>
              <div className="vuhlp-graph__legend-section">
                <span className="vuhlp-graph__legend-title">Status</span>
                <div className="vuhlp-graph__legend-items">
                  <span className="vuhlp-graph__legend-item">
                    <span className="vuhlp-graph__legend-dot" style={{ background: STATUS_COLORS.queued }} />
                    Queued
                  </span>
                  <span className="vuhlp-graph__legend-item">
                    <span className="vuhlp-graph__legend-dot vuhlp-graph__legend-dot--pulse" style={{ background: STATUS_COLORS.running }} />
                    Running
                  </span>
                  <span className="vuhlp-graph__legend-item">
                    <span className="vuhlp-graph__legend-dot" style={{ background: STATUS_COLORS.completed }} />
                    Done
                  </span>
                  <span className="vuhlp-graph__legend-item">
                    <span className="vuhlp-graph__legend-dot" style={{ background: STATUS_COLORS.failed }} />
                    Failed
                  </span>
                </div>
              </div>
              <div className="vuhlp-graph__legend-section">
                <span className="vuhlp-graph__legend-title">Provider</span>
                <div className="vuhlp-graph__legend-items">
                  <span className="vuhlp-graph__legend-item">
                    <span className="vuhlp-graph__legend-dot" style={{ background: PROVIDER_COLORS.claude }} />
                    Claude
                  </span>
                  <span className="vuhlp-graph__legend-item">
                    <span className="vuhlp-graph__legend-dot" style={{ background: PROVIDER_COLORS.codex }} />
                    Codex
                  </span>
                  <span className="vuhlp-graph__legend-item">
                    <span className="vuhlp-graph__legend-dot" style={{ background: PROVIDER_COLORS.gemini }} />
                    Gemini
                  </span>
                </div>
              </div>
              <div className="vuhlp-graph__legend-section">
                <span className="vuhlp-graph__legend-title">Connections</span>
                <div className="vuhlp-graph__legend-items">
                  <span className="vuhlp-graph__legend-item">
                    <span className="vuhlp-graph__legend-line vuhlp-graph__legend-line--dependency" />
                    Dependency
                  </span>
                  <span className="vuhlp-graph__legend-item">
                    <span className="vuhlp-graph__legend-line vuhlp-graph__legend-line--handoff" />
                    Handoff
                  </span>
                  <span className="vuhlp-graph__legend-item">
                    <span className="vuhlp-graph__legend-line vuhlp-graph__legend-line--report" />
                    Report
                  </span>
                  <span className="vuhlp-graph__legend-item">
                    <span className="vuhlp-graph__legend-line vuhlp-graph__legend-line--gate" />
                    Gate
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
