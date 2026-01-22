import { useEffect, useRef, useCallback, useState, useMemo, type ChangeEvent } from 'react';
import cytoscape, { type Core, type EventObject } from 'cytoscape';
import type {
  Run,
  RunMode,
  GlobalMode,
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
  DEFAULT_WINDOW_SIZE,
  OVERVIEW_WINDOW_SIZE,
  SNAP_SIZE,
} from './coordinateUtils';
import './GraphPane.css';

// Storage key prefix for node positions
const POSITION_STORAGE_PREFIX = 'vuhlp-graph-positions-';
const OVERVIEW_ZOOM_THRESHOLD = 0.35;
const OVERVIEW_ZOOM_MARGIN = 0.01;
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
type PortKind = 'input' | 'output' | 'left' | 'right';
type CyNodeCollection = ReturnType<Core['nodes']>;

interface EdgeDragState {
  edgeId: string;
  end: EdgeEndpoint;
  fixedPosition: Position;
  currentPosition: Position;
  isOverValidTarget: boolean;
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
  if (port !== 'input' && port !== 'output' && port !== 'left' && port !== 'right') return null;
  return { nodeId, port: port as PortKind };
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


  const heightValue = element.data('height');
  const widthValue = element.data('width');

  const height = typeof heightValue === 'number' ? heightValue : DEFAULT_WINDOW_SIZE.height;
  const width = typeof widthValue === 'number' ? widthValue : DEFAULT_WINDOW_SIZE.width;

  const zoom = cy.zoom();
  const pan = cy.pan();
  const pos = element.position();
  const center = {
    x: pos.x * zoom + pan.x,
    y: pos.y * zoom + pan.y,
  };
  const scaledHeight = height * zoom;
  const scaledWidth = width * zoom;
  
  if (port === 'input') {
    return { x: center.x, y: center.y - scaledHeight / 2 };
  } else if (port === 'output') {
    return { x: center.x, y: center.y + scaledHeight / 2 };
  } else if (port === 'left') {
    return { x: center.x - scaledWidth / 2, y: center.y };
  } else if (port === 'right') {
    return { x: center.x + scaledWidth / 2, y: center.y };
  }
  
  return center;
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

interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string;
}

interface EdgeContextMenuState {
  x: number;
  y: number;
  edgeId: string;
  sourceId: string;
  targetId: string;
  sourceLabel: string;
  targetLabel: string;
  bidirectional: boolean;
}

export interface GraphPaneProps {
  run: Run | null;
  onNodeSelect: (nodeId: string | null) => void;
  selectedNodeId: string | null;
  onEdgeUpdate?: (edgeId: string, updates: { source?: string; target?: string; bidirectional?: boolean }) => void;
  onEdgeCreate?: (sourceId: string, targetId: string) => void;
  onEdgeDelete?: (edgeId: string) => void;
  onNodeCreate?: (
    providerId: string,
    label: string,
    options?: {
      role?: string;
      customSystemPrompt?: string;
      policy?: { allowedTools?: string[]; approvalMode?: 'always' | 'high_risk_only' | 'never' };
    }
  ) => void;
  onNodeDelete?: (nodeId: string) => void;
  onNodeDuplicate?: (nodeId: string) => void;
  onStop: () => void;
  onPause: () => void;
  onResume: (feedback?: string) => void;
  interactionMode: InteractionMode;
  onInteractionModeChange: (mode: InteractionMode) => void;
  runMode: RunMode;
  onRunModeChange: (mode: RunMode) => void;
  globalMode: GlobalMode;
  onGlobalModeChange: (mode: GlobalMode) => void;
  /** Whether CLI permissions are skipped (true = skip, false = require approval) */
  skipCliPermissions: boolean;
  onSkipCliPermissionsChange: (skip: boolean) => void;
  runPhase: RunPhase | null;
  getNodeTrackedState: (runId: string, nodeId: string) => NodeTrackedState;
  onNodeMessage?: (nodeId: string, content: string) => void;
  onStopNode?: (nodeId: string) => void;
  onRestartNode?: (nodeId: string) => void;
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

const EDGE_HIGHLIGHT_COLOR = '#d946ef';

interface PortTooltipState {
  nodeId: string;
  port: 'input' | 'output' | 'left' | 'right';
}

export function GraphPane({
  run,
  onNodeSelect,
  selectedNodeId,
  onEdgeUpdate,
  onEdgeCreate,
  onEdgeDelete,
  onNodeCreate,
  onNodeDelete,
  onNodeDuplicate,
  onStop,
  onPause,
  onResume,
  interactionMode: _interactionMode,
  onInteractionModeChange: _onInteractionModeChange,
  runMode,
  onRunModeChange,
  globalMode,
  onGlobalModeChange,
  skipCliPermissions,
  onSkipCliPermissionsChange,
  runPhase,
  getNodeTrackedState,
  onNodeMessage,
  onStopNode,
  onRestartNode,
}: GraphPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const runIdRef = useRef<string | null>(null);
  const savedPositionsRef = useRef<SavedPositions | null>(null);
  const nodeLabelRef = useRef<Record<string, string>>({});
  const lastFollowedNodeIdRef = useRef<string | null>(null);
  const syncRef = useRef<number | null>(null);
  const handoffTimerRef = useRef<number | null>(null);
  const centeringNodeIdRef = useRef<string | null>(null);

  // Viewport state for coordinate transformations
  const [viewport, setViewport] = useState({ zoom: 1, pan: { x: 0, y: 0 } });
  
  // Graph visual settings
  const [connectionStyle, setConnectionStyle] = useState<ConnectionStyle>('bezier');
  const [legendCollapsed, setLegendCollapsed] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [followRunning, setFollowRunning] = useState(false);
  const [edgeTooltip, setEdgeTooltip] = useState<EdgeTooltipState | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [portTooltip, setPortTooltip] = useState<PortTooltipState | null>(null);
  const [edgeDrag, setEdgeDrag] = useState<EdgeDragState | null>(null);
  const [newEdgeDrag, setNewEdgeDrag] = useState<{ sourceId: string; sourcePort: PortKind; currentPosition: Position } | null>(null);
  const [highlightedPort, setHighlightedPort] = useState<{ nodeId: string; port: 'input' | 'output' | 'left' | 'right' } | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [edgeContextMenu, setEdgeContextMenu] = useState<EdgeContextMenuState | null>(null);
  const [canvasContextMenu, setCanvasContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [addAgentModal, setAddAgentModal] = useState({
    open: false,
    providerId: 'claude',
    label: '',
    role: 'implementer',
    useCustomPrompt: false,
    customSystemPrompt: '',
  });

  // Node positions from Cytoscape (model coordinates)
  const [nodePositions, setNodePositions] = useState<Record<string, Position>>({});

  // Window sizes
  const { getWindowSize, resetWindowSizes } = useNodeWindowState(run?.id || null);
  const windowsLayerRef = useRef<HTMLDivElement>(null);

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

  const {
    portHighlightedNodeIds,
    portHighlightedEdgeIds,
  } = useMemo(() => {
    if (!highlightedPort) {
      return {
        portHighlightedNodeIds: new Set<string>(),
        portHighlightedEdgeIds: new Set<string>(),
      };
    }

    const { nodeId, port } = highlightedPort;
    const highlightNodes = new Set<string>();
    const highlightEdges = new Set<string>();

    edges.forEach((edge) => {
      if (port === 'output') {
        if (edge.source === nodeId) {
          highlightEdges.add(edge.id);
          highlightNodes.add(edge.target);
        }
      } else {
        if (edge.target === nodeId) {
          highlightEdges.add(edge.id);
          highlightNodes.add(edge.source);
        }
      }
    });

    return {
      portHighlightedNodeIds: highlightNodes,
      portHighlightedEdgeIds: highlightEdges,
    };
  }, [highlightedPort, edges]);

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
    // If we are actively centering this node, force it to be full size
    // ensuring the zoom animation targets the detailed view dimensions
    if (centeringNodeIdRef.current === nodeId) {
      return getWindowSize(nodeId);
    }
    if (isOverview) return OVERVIEW_WINDOW_SIZE;
    return getWindowSize(nodeId);
  }, [isOverview, getWindowSize]);

  // Return base model size (no zoom applied)
  const getScaledSize = useCallback((nodeId: string): Size => {
    return getEffectiveWindowSize(nodeId);
  }, [getEffectiveWindowSize]);

  // Return base model position (top-left) - no viewport transform applied
  // The layer itself will be transformed
  const getRelativePosition = useCallback((nodeId: string, size: Size): Position => {
    const modelPos = nodePositions[nodeId];
    if (!modelPos) return { x: 0, y: 0 };
    return {
      x: modelPos.x - size.width / 2,
      y: modelPos.y - size.height / 2,
    };
  }, [nodePositions]);

  const getPortPosition = useCallback((nodeId: string, port: PortKind): Position | null => {
    const modelPos = nodePositions[nodeId];
    if (!modelPos) return null;
    const center = cyToScreen(modelPos, viewport);
    // Port positions still need screen coordinates for drag lines (which are in SVG overlay)
    // The SVG overlay is currently NOT transformed with the windows layer (it's separate)
    // So we invoke `getEffectiveWindowSize` and apply zoom manually for the ports
    // or rely on cyToScreen which uses the current viewport.
    
    // For ports, we need the scaled height to apply offset
    const baseSize = getEffectiveWindowSize(nodeId);
    const scaledHeight = baseSize.height * viewport.zoom;
    const yOffset = port === 'input' ? -scaledHeight / 2 : scaledHeight / 2;
    return {
      x: center.x,
      y: center.y + yOffset,
    };
  }, [nodePositions, viewport, getEffectiveWindowSize]);

  const updateWindowsLayerTransform = useCallback(() => {
    const layer = windowsLayerRef.current;
    const cy = cyRef.current;
    if (!layer || !cy) return;

    const pan = cy.pan();
    const zoom = cy.zoom();
    
    layer.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    layer.style.transformOrigin = '0 0';
  }, []);

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
    const currentZoom = cy.zoom();
    setViewport({
      zoom: currentZoom,
      pan: currentPan,
    });
    
    // Explicitly update transform here too to ensure sync
    updateWindowsLayerTransform();
  }, [updateWindowsLayerTransform]);

  const updateAllEdgeCurves = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
      cy.edges().forEach((edge) => {
        // if (connectionStyle !== 'bezier') return; // We now want to update endpoints for all styles

        const source = edge.source();
        const target = edge.target();
        
        // Get positions (center)
        const sPos = source.position();
        const tPos = target.position();
        
        const dx = tPos.x - sPos.x;
        const dy = tPos.y - sPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist === 0) return;

        // Calculate Optimal Endpoints for Shortest Path
        const w = Math.abs(dx);
        const h = Math.abs(dy);
        
        let sourceEndpoint = '0% 0%';
        let targetEndpoint = '0% 0%';

        if (w > h) {
           // Horizontal dominance
           if (dx > 0) {
              // Target is to the Right of Source
              sourceEndpoint = '50% 0%';  // Source Right
              targetEndpoint = '-50% 0%'; // Target Left
           } else {
              // Target is to the Left of Source
              sourceEndpoint = '-50% 0%'; // Source Left
              targetEndpoint = '50% 0%';  // Target Right
           }
        } else {
           // Vertical dominance
           if (dy > 0) {
              // Target is Below Source
              sourceEndpoint = '0% 50%';  // Source Bottom
              targetEndpoint = '0% -50%'; // Target Top
           } else {
              // Target is Above Source
              sourceEndpoint = '0% -50%'; // Source Top
              targetEndpoint = '0% 50%';  // Target Bottom
           }
        }

        if (connectionStyle === 'bezier') {
          let d1 = 0;
          let d2 = 0;
          let w1 = 0.5;
          let w2 = 0.5;

          // Calculate offset ratio - how diagonal is the connection?
          // 0 = perfectly aligned, 1 = 45 degrees diagonal
          const offsetRatio = w > h ? h / (w + 1) : w / (h + 1);

          // Only add curve when connection is nearly diagonal (would clip node corners)
          // Threshold 0.6 = ~31° off-axis, below this straight line works fine
          if (offsetRatio > 0.6) {
            const curveStrength = Math.min(1, (offsetRatio - 0.6) * 2.5);

            if (w > h) {
              // Horizontal ports with significant vertical offset
              const extension = Math.min(120, Math.abs(dx) * 0.25) * curveStrength;
              w1 = 0.15;
              w2 = 0.85;
              d1 = dy > 0 ? extension : -extension;
              d2 = dy > 0 ? -extension : extension;
            } else {
              // Vertical ports with significant horizontal offset
              // Curve AWAY from source node (toward the target side)
              const extension = Math.min(120, Math.abs(dy) * 0.25) * curveStrength;
              w1 = 0.15;
              w2 = 0.85;
              d1 = dx > 0 ? extension : -extension;
              d2 = dx > 0 ? -extension : extension;
            }
          }

          edge.data({
            cpDistances: [d1, d2],
            cpWeights: [w1, w2],
            sourceEndpoint,
            targetEndpoint,
          });
        } else {
           // For non-bezier, just update endpoints
           edge.data({
            sourceEndpoint,
            targetEndpoint,
           });
        }
      });
    });
  }, [connectionStyle]);

  // Throttled sync for high-frequency events
  const throttledSync = useCallback(() => {
    if (syncRef.current) return;
    syncRef.current = requestAnimationFrame(() => {
      syncPositionsFromCy();
      updateAllEdgeCurves();
      syncRef.current = null;
    });
  }, [syncPositionsFromCy, updateAllEdgeCurves]);

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

    if (sourceDistance > EDGE_HANDLE_RADIUS && targetDistance > EDGE_HANDLE_RADIUS) {
       // Clicked on edge body -> Select it
       setSelectedEdgeId(edge.id());
       onNodeSelect(null); // Deselect node if any
       return;
    }

    const end: EdgeEndpoint = sourceDistance <= targetDistance ? 'source' : 'target';
    const fixedPosition = end === 'source' ? targetPort : sourcePort;

    setEdgeDrag({
      edgeId: edge.id(),
      end,
      fixedPosition,
      currentPosition: position,
      isOverValidTarget: false,
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
      userZoomingEnabled: false,
      style: [
        {
          // Nodes serve as invisible anchors with correct dimensions for edge routing
          selector: 'node',
          style: {
            'background-opacity': 0,
            'border-width': 0,
            width: 1, // Default fallback
            height: 1, // Default fallback
            shape: 'round-rectangle',
            label: '',
          },
        },
        {
          selector: 'node[width][height]',
          style: {
             width: 'data(width)',
             height: 'data(height)',
          }
        },
        {
          selector: 'edge',
          style: {
            width: 2,
            'line-color': EDGE_COLORS.dependency,
            'target-arrow-color': EDGE_COLORS.dependency,
            'target-arrow-shape': 'triangle',
            'source-arrow-color': EDGE_COLORS.dependency,
            'curve-style': connectionStyle === 'bezier' ? 'unbundled-bezier' : connectionStyle,
            'taxi-direction': 'vertical',
            'taxi-turn': 20,
            'arrow-scale': 1,
            'opacity': 0.85,
          },
        },
        {
          selector: 'edge[sourceEndpoint]',
          style: {
            'source-endpoint': 'data(sourceEndpoint)',
          },
        },
        {
          selector: 'edge[targetEndpoint]',
          style: {
            'target-endpoint': 'data(targetEndpoint)',
          },
        },
        {
          selector: 'edge[cpDistances][cpWeights]',
          style: {
            'control-point-distances': 'data(cpDistances)',
            'control-point-weights': 'data(cpWeights)',
          },
        },
        {
          selector: 'edge[sourceArrowShape]',
          style: {
            'source-arrow-shape': 'data(sourceArrowShape)',
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

    // Add highlight style
    cy.style()
      .selector('edge.vuhlp-edge--port-highlight')
      .style({
        'line-color': EDGE_HIGHLIGHT_COLOR,
        'target-arrow-color': EDGE_HIGHLIGHT_COLOR,
        'width': 3,
        'opacity': 1,
        'z-index': 999,
      })
      .selector('edge.vuhlp-edge--selected')
      .style({
        'line-color': '#3b82f6', // bright blue
        'target-arrow-color': '#3b82f6',
        'width': 4,
        'opacity': 1,
        'z-index': 1000,
        // 'text-outline-color': '#3b82f6', // if we had labels
        // 'text-outline-width': 2,
      })
      .update();

    // Click on canvas to deselect
    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) {
        onNodeSelect(null);
        setHoveredEdgeId(null);
        setSelectedEdgeId(null);
        setEdgeTooltip(null);
        setPortTooltip(null);
        setHighlightedPort(null);
        setCanvasContextMenu(null);
      }
    });

    // Right-click on canvas to show "Add Agent" menu
    cy.on('cxttap', (evt: EventObject) => {
      if (evt.target === cy) {
        // Use clientX/clientY directly since context menu is position: fixed
        if (evt.originalEvent && evt.originalEvent instanceof MouseEvent) {
          setCanvasContextMenu({ x: evt.originalEvent.clientX, y: evt.originalEvent.clientY });
          setContextMenu(null);
          setEdgeContextMenu(null);
        }
      }
    });

    // Sync positions when viewport changes (throttled)
    cy.on('pan zoom render', () => {
      throttledSync();
      // Immediate transform update for smooth 60fps
      updateWindowsLayerTransform();
    });

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

    const handleEdgeCxttap = (evt: EventObject) => {
      if (!('source' in evt.target)) return;
      if (!evt.originalEvent) return;

      evt.originalEvent.preventDefault();

      const edge = evt.target;
      const sourceId = edge.source().id();
      const targetId = edge.target().id();
      const sourceLabel = nodeLabelRef.current[sourceId] || sourceId;
      const targetLabel = nodeLabelRef.current[targetId] || targetId;

      const mouseEvt = evt.originalEvent as MouseEvent;
      const bidirectional = edge.data('bidirectional') === true;
      setEdgeContextMenu({
        x: mouseEvt.clientX,
        y: mouseEvt.clientY,
        edgeId: edge.id(),
        sourceId,
        targetId,
        sourceLabel,
        targetLabel,
        bidirectional,
      });
      setEdgeTooltip(null);
    };

    cy.on('mouseover', 'edge', handleEdgeOver);
    cy.on('mousemove', 'edge', handleEdgeMove);
    cy.on('mouseout', 'edge', handleEdgeOut);
    cy.on('mousedown', 'edge', handleEdgeMouseDown);
    cy.on('cxttap', 'edge', handleEdgeCxttap);

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


    // Resize observer to handle container size changes
    const resizeObserver = new ResizeObserver(() => {
        cy.resize();
        // optionally throttle sync here?
        throttledSync();
        updateWindowsLayerTransform();
    });
    if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
    }

    // Manual zoom/pan handling
    const handleWheel = (e: WheelEvent) => {
      const cy = cyRef.current;
      if (!cy) return;

      // Check if scrolling inside a focused node window's content area
      // If so, let the content scroll instead of zooming the graph
      const target = e.target as HTMLElement;
      const focusedNode = target.closest('.vuhlp-node-window--focused');
      if (focusedNode) {
        // Check if the target or an ancestor is scrollable content
        const scrollableContent = target.closest('.term-content, .vuhlp-node-window__content');
        if (scrollableContent) {
          const el = scrollableContent as HTMLElement;
          // Use a small epsilon or round to handle fractional pixels (common with scaling)
          const canScrollUp = el.scrollTop > 0;
          const canScrollDown = Math.ceil(el.scrollTop + el.clientHeight) < el.scrollHeight;
          const scrollingUp = e.deltaY < 0;
          const scrollingDown = e.deltaY > 0;

          // Allow native scroll if there's room to scroll in that direction
          if ((scrollingUp && canScrollUp) || (scrollingDown && canScrollDown)) {
            // Don't prevent default - let the content scroll naturally
            e.stopPropagation();
            return;
          }
        }
        
        // If we're focused but can't scroll (or not over scrollable area), 
        // BLOCK the external zoom.
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      e.preventDefault();

      // Zoom the graph
      // Pan is handled by click-drag on canvas (default cytoscape behavior via userPanningEnabled: true)

      const zoom = cy.zoom();
      const delta = e.deltaY;
      const factor = Math.pow(1.001, -delta);

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      cy.zoom({
        level: zoom * factor,
        renderedPosition: { x, y }
      });
    };

    const wrapper = wrapperRef.current;
    if (wrapper) {
        wrapper.addEventListener('wheel', handleWheel, { passive: false });
    }

    return () => {
      if (wrapper) {
          wrapper.removeEventListener('wheel', handleWheel);
      }
      resizeObserver.disconnect();
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
        'curve-style': connectionStyle === 'bezier' ? 'unbundled-bezier' : connectionStyle,
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
    portHighlightedEdgeIds,
  ]);

  // Apply port highlight styles
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
      cy.edges().forEach((edge) => {
        if (portHighlightedEdgeIds.has(edge.id())) {
          edge.addClass('vuhlp-edge--port-highlight');
        } else {
          edge.removeClass('vuhlp-edge--port-highlight');
        }
      });
    });
  }, [portHighlightedEdgeIds]);

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

  // Close context menu when clicking elsewhere
  useEffect(() => {
    if (!contextMenu) return;

    const handleClick = () => {
      setContextMenu(null);
    };

    const handleContextMenu = (e: MouseEvent) => {
      // Only close if right-clicking outside the menu
      const target = e.target as HTMLElement;
      if (!target.closest('.vuhlp-graph__context-menu')) {
        setContextMenu(null);
      }
    };

    document.addEventListener('click', handleClick);
    document.addEventListener('contextmenu', handleContextMenu);

    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [contextMenu]);

  // Close edge context menu when clicking elsewhere
  useEffect(() => {
    if (!edgeContextMenu) return;

    const handleClick = () => {
      setEdgeContextMenu(null);
    };

    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.vuhlp-graph__context-menu')) {
        setEdgeContextMenu(null);
      }
    };

    document.addEventListener('click', handleClick);
    document.addEventListener('contextmenu', handleContextMenu);

    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [edgeContextMenu]);

  const centerStage = useCallback((nodeId: string) => {
    const cy = cyRef.current;
    if (!cy) return;

    const node = cy.getElementById(nodeId);
    if (!('position' in node) || !node.nonempty()) return;

    // Force the node to its full size for the fit calculation
    // This prevents "zooming in too far" if the node is currently in overview mode (small size)
    const targetSize = getWindowSize(nodeId);
    
    // Set ref to prevent getEffectiveWindowSize from reverting it to small size
    centeringNodeIdRef.current = nodeId;
    // Mark center stage mode active immediately to register intent
    centerStageActiveRef.current = true;
    lastZoomOutWasFitRef.current = false;
    
    node.data({
      width: targetSize.width,
      height: targetSize.height,
    });

    cy.animate({
      fit: {
        eles: node,
        padding: 50,
      },
      duration: 500,
      easing: 'ease-in-out-cubic',
      complete: () => {
        // Clear the centering ref when done
        // Note: by now, we should be close enough that isOverview is false
        // so the next render will keep it large naturally
        if (centeringNodeIdRef.current === nodeId) {
          centeringNodeIdRef.current = null;
        }
      }
    });

  }, [getWindowSize]);

  // Sync selected edge state to Cytoscape
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.edges().removeClass('vuhlp-edge--selected');
    if (selectedEdgeId) {
      cy.getElementById(selectedEdgeId).addClass('vuhlp-edge--selected');
    }
  }, [selectedEdgeId]);

  // Cycle state refs
  const inputCycleIndexRef = useRef<number>(-1);
  const outputCycleIndexRef = useRef<number>(-1);

  // Track whether we're currently in center stage mode (for 'f' key toggle)
  const centerStageActiveRef = useRef<boolean>(false);
  const lastZoomOutWasFitRef = useRef<boolean>(false);

  // Reset cycle state when selection changes
  useEffect(() => {
    inputCycleIndexRef.current = -1;
    outputCycleIndexRef.current = -1;
  }, [selectedNodeId]);

  const getSortedNeighbors = useCallback((nodeId: string, direction: 'input' | 'output') => {
    const cy = cyRef.current;
    if (!cy) return [];

    const neighborIds = new Set<string>();
    edges.forEach((edge) => {
      if (direction === 'input') {
        if (edge.target === nodeId) neighborIds.add(edge.source);
      } else {
        if (edge.source === nodeId) neighborIds.add(edge.target);
      }
    });

    const neighbors = Array.from(neighborIds).flatMap((id) => {
      const node = cy.getElementById(id);
      if (!('position' in node) || !node.nonempty()) return [];
      return [{ id, pos: node.position() }];
    });

    // Sort top-to-bottom, then left-to-right
    neighbors.sort((a, b) => {
      if (Math.abs(a.pos.y - b.pos.y) > 5) return a.pos.y - b.pos.y;
      return a.pos.x - b.pos.x;
    });

    return neighbors.map(n => n.id);
  }, [edges]);

  const requestNodeDelete = useCallback((nodeId: string) => {
    if (!onNodeDelete) return;
    if (run?.rootOrchestratorNodeId && nodeId === run.rootOrchestratorNodeId) {
      window.alert('Cannot delete the Root Orchestrator node.');
      return;
    }

    const node = nodes.find((item) => item.id === nodeId);
    if (!node) return;

    const trackedState = run ? getNodeTrackedState(run.id, nodeId) : undefined;
    const hasActivity = Boolean(
      trackedState &&
      (trackedState.messages.length ||
        trackedState.tools.length ||
        trackedState.consoleChunks.length ||
        trackedState.events.length)
    );
    const isWaitingForEvents = node.status === 'queued' && !hasActivity;
    if (!isWaitingForEvents) {
      const label = node.label || node.id.slice(0, 8);
      const confirmed = window.confirm(
        `Delete "${label}"? This agent is ${node.status} (not waiting for events).`
      );
      if (!confirmed) return;
    }

    onNodeDelete(nodeId);
  }, [getNodeTrackedState, onNodeDelete, nodes, run?.id, run?.rootOrchestratorNodeId]);

  const handleDuplicateAgent = useCallback((nodeId?: string) => {
    const targetNodeId = nodeId || selectedNodeId;
    if (targetNodeId && onNodeDuplicate) {
      onNodeDuplicate(targetNodeId);
    }
    setContextMenu(null);
  }, [selectedNodeId, onNodeDuplicate]);

  // Keyboard shortcut for center stage and cycling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

      // Escape deselects the current node (works even when in input)
      if (e.key === 'Escape' && selectedNodeId) {
        if (isInInput) {
          (target as HTMLInputElement | HTMLTextAreaElement).blur();
        }
        onNodeSelect(null);
        return;
      }

      // Other shortcuts only trigger if not typing in an input
      if (isInInput) return;

      if ((e.key.toLowerCase() === 'q' && e.shiftKey) || e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodeId) {
          e.preventDefault();
          requestNodeDelete(selectedNodeId);
          return;
        }
        if (selectedEdgeId && onEdgeDelete) {
           e.preventDefault();
           onEdgeDelete(selectedEdgeId);
           setSelectedEdgeId(null);
           return;
        }
        return;
      }

      if (e.key === 'f') {
        const cy = cyRef.current;
        if (!cy) return;

        const clampToOverview = () => {
          const currentZoom = cy.zoom();
          const overviewZoomTarget = Math.min(
            currentZoom,
            OVERVIEW_ZOOM_THRESHOLD - OVERVIEW_ZOOM_MARGIN
          );
          if (overviewZoomTarget >= currentZoom) return;

          const rect = containerRef.current?.getBoundingClientRect();
          if (!rect) {
            cy.zoom(overviewZoomTarget);
            return;
          }

          cy.animate({
            zoom: {
              level: overviewZoomTarget,
              renderedPosition: { x: rect.width / 2, y: rect.height / 2 },
            },
            duration: 250,
            easing: 'ease-in-out-cubic',
          });
        };

        // Toggle: if we're in center stage mode, zoom out; otherwise center on the selection
        if (centerStageActiveRef.current) {
          centerStageActiveRef.current = false;
          centeringNodeIdRef.current = null; // Ensure we stop forcing large size
          cy.stop(); // Stop any ongoing animation

          if (visibleNodes.length <= 1) {
            lastZoomOutWasFitRef.current = false;
            clampToOverview();
            return;
          }

          // Zoom out to fit all nodes
          lastZoomOutWasFitRef.current = true;
          cy.animate({
            fit: {
              eles: cy.elements(),
              padding: 50,
            },
            duration: 500,
            easing: 'ease-in-out-cubic',
          });
          return;
        }

        if (lastZoomOutWasFitRef.current && !isOverview) {
          lastZoomOutWasFitRef.current = false;
          clampToOverview();
          return;
        }

        if (!selectedNodeId) return;

        // Center stage on the selected node
        lastZoomOutWasFitRef.current = false;
        centerStage(selectedNodeId);
        return;
      }

      // Shift+D to duplicate the selected agent
      if (e.key === 'D' && e.shiftKey && selectedNodeId) {
        e.preventDefault();
        handleDuplicateAgent(selectedNodeId);
        return;
      }

      if (!selectedNodeId) return;

      if (e.key === 'i') {
        const neighbors = getSortedNeighbors(selectedNodeId, 'input');
        if (neighbors.length === 0) return;

        inputCycleIndexRef.current = (inputCycleIndexRef.current + 1) % neighbors.length;
        centerStage(neighbors[inputCycleIndexRef.current]); 
      } else if (e.key === 'o') {
        const neighbors = getSortedNeighbors(selectedNodeId, 'output');
        if (neighbors.length === 0) return;

        outputCycleIndexRef.current = (outputCycleIndexRef.current + 1) % neighbors.length;
        centerStage(neighbors[outputCycleIndexRef.current]);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNodeId, centerStage, getSortedNeighbors, isOverview, onNodeSelect, requestNodeDelete, visibleNodes, handleDuplicateAgent]);

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
          bidirectional: edge.bidirectional,
          sourceArrowShape: edge.bidirectional ? 'triangle' : 'none',
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
      if (target && onEdgeCreate) {
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

    const isValidDrop = (_end: EdgeEndpoint, _port: PortKind) => {
      return true;
    };

    const handleMouseMove = (evt: MouseEvent) => {
      const position = getPointerPositionFromMouseEvent(containerRef.current, evt);
      if (!position) return;

      const target = getPortTargetFromPoint(evt.clientX, evt.clientY);
      const isValid = target !== null && isValidDrop(edgeDrag.end, target.port);

      if (isValid && target) {
        const targetPosition = getPortPosition(target.nodeId, target.port);
        if (targetPosition) {
          setEdgeDrag((current) => (current ? {
            ...current,
            currentPosition: targetPosition,
            isOverValidTarget: true,
          } : current));
          return;
        }
      }

      setEdgeDrag((current) => (current ? {
        ...current,
        currentPosition: position,
        isOverValidTarget: false,
      } : current));
    };

    const handleMouseUp = (evt: MouseEvent) => {
      const target = getPortTargetFromPoint(evt.clientX, evt.clientY);
      if (target && isValidDrop(edgeDrag.end, target.port)) {
        // Reconnect to a new node
        if (edgeDrag.end === 'source') {
          onEdgeUpdate?.(edgeDrag.edgeId, { source: target.nodeId });
        } else {
          onEdgeUpdate?.(edgeDrag.edgeId, { target: target.nodeId });
        }
      } else {
        // Dropped off a valid port - disconnect the edge
        onEdgeDelete?.(edgeDrag.edgeId);
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
  }, [edgeDrag, getPortPosition, onEdgeUpdate, onEdgeDelete]);

  // Handle window position change (from drag)
  const handlePositionChange = useCallback((
    nodeId: string,
    deltaX: number,
    deltaY: number,
    options?: { snap?: boolean; transient?: boolean }
  ) => {
    const cy = cyRef.current;
    if (!cy) return;

    const shouldSnap = options?.snap ?? true;
    const isTransient = options?.transient ?? false;
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

    if (!isTransient) {
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
    }

    // Immediate curve update for smooth drag (always do this for endpoints)
    // Use local curve update instead of full updateAllEdgeCurves for performance if possible,
    // but updateAllEdgeCurves is already optimized via batch.
    updateAllEdgeCurves();
  }, [throttledSync, updateAllEdgeCurves]);

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

  const handlePortMouseDown = useCallback((nodeId: string, port: PortKind, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    // Only allow starting drag from output/right/left ports (acting as source) 
    // or we could allow dragging FROM input to output? 
    // Standard behavior: Drag from Output -> Input.
    // For bidirectional/side ports: Let's assume they can act as Source OR Target.
    // Simplifying: Allow dragging FROM any port.
    
    // However, if we want to enforce One-Way by default, usually we drag from Output.
    // Let's assume 'left'/'right' can also start connections.
    
    // We need the screen position of the port
    const portPos = getCyPortPosition(cyRef.current!, nodeId, port);
    if (!portPos) return;

    // Convert screen pos to ensure we have a valid starting point
    // We already have portPos in screen coords from getCyPortPosition (which returns screen coords)
    
    // We need screen coordinates for the drag line which is in an SVG overlay 
    // The SVG overlay is fixed to the viewport? No, it's usually absolute.
    // GraphPane.css -> .vuhlp-graph__edge-drag-layer
    
    // We need to resolve pointer position relative to the container.
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    
    setNewEdgeDrag({
      sourceId: nodeId,
      sourcePort: port,
      currentPosition: portPos,
    });
    // Deselect potentially selected node to avoid dragging it
    if (selectedNodeId) onNodeSelect(null);
  }, [onNodeSelect, selectedNodeId]);

  const handlePortClick = useCallback((nodeId: string, port: PortKind, _e: React.MouseEvent) => {
    // If clicking the same port, toggle off
    if (portTooltip?.nodeId === nodeId && portTooltip?.port === port) {
      setPortTooltip(null);
      return;
    }

    setPortTooltip({
      nodeId,
      port,
    });
  }, [portTooltip]);

  const handleNodeContextMenu = useCallback((nodeId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      nodeId,
    });
  }, []);

  const handleDeleteAgent = useCallback(() => {
    if (contextMenu) {
      requestNodeDelete(contextMenu.nodeId);
    }
    setContextMenu(null);
  }, [contextMenu, requestNodeDelete]);

  const handleRemoveEdge = useCallback(() => {
    if (edgeContextMenu && onEdgeDelete) {
      onEdgeDelete(edgeContextMenu.edgeId);
    }
    setEdgeContextMenu(null);
  }, [edgeContextMenu, onEdgeDelete]);

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
          centerStage(selectedNodeId);
      }
  }, [selectedNodeId, centerStage]);

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

          {/* Global Mode Toggle */}
          {run && (
            <div className="vuhlp-graph__mode-toggle" style={{ marginLeft: 8 }}>
              <button
                className={`vuhlp-graph__mode-btn ${globalMode === 'PLANNING' ? 'vuhlp-graph__mode-btn--active' : ''}`}
                onClick={() => onGlobalModeChange('PLANNING')}
                title="Planning Mode: Analyze and Plan"
              >
                Plan
              </button>
              <button
                className={`vuhlp-graph__mode-btn ${globalMode === 'IMPLEMENTATION' ? 'vuhlp-graph__mode-btn--active' : ''}`}
                onClick={() => onGlobalModeChange('IMPLEMENTATION')}
                title="Implementation Mode: Execute Changes"
              >
                Implement
              </button>
            </div>
          )}

          {/* Permissions Toggle */}
          {run && (
            <div className="vuhlp-graph__mode-toggle" style={{ marginLeft: 8 }}>
              <button
                className={`vuhlp-graph__mode-btn ${skipCliPermissions ? 'vuhlp-graph__mode-btn--active' : ''}`}
                onClick={() => onSkipCliPermissionsChange(true)}
                title="Skip Permissions: Tools run immediately without approval"
              >
                Skip Perms
              </button>
              <button
                className={`vuhlp-graph__mode-btn ${!skipCliPermissions ? 'vuhlp-graph__mode-btn--active' : ''}`}
                onClick={() => onSkipCliPermissionsChange(false)}
                title="Require Permissions: Tools require approval before running"
              >
                Require Perms
              </button>
            </div>
          )}

          {/* Add Node Button */}
          {run && onNodeCreate && (
             <button
                className="vuhlp-graph__control-btn"
                onClick={() => setAddAgentModal({ ...addAgentModal, open: true, label: '', customSystemPrompt: '', useCustomPrompt: false })}
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
                title="Global Stop (Kill All Workers)"
              >
                <svg viewBox="0 0 16 16" fill="currentColor">
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                </svg>
              </button>
            </div>
          )}

          {/* Zoom Controls */}
          <div className="vuhlp-graph__zoom-controls">
            <button 
              className={`vuhlp-graph__zoom-btn ${showInfo ? 'vuhlp-graph__zoom-btn--active' : ''}`}
              onClick={() => setShowInfo(prev => !prev)}
              title="Shortcuts Info"
            >
               <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="8" cy="8" r="6" />
                  <path d="M8 8v4M8 4v.01" strokeLinecap="round" />
               </svg>
            </button>
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
      <div 
        ref={wrapperRef}
        className={`vuhlp-graph__canvas-container ${showGrid ? 'vuhlp-graph__canvas-container--grid' : ''}`}
      >
        <div ref={containerRef} className="vuhlp-graph__canvas" />

        {/* Windows Layer - HTML nodes on top of canvas */}
        {run && run.nodes && (
          <div className="vuhlp-graph__windows-layer" ref={windowsLayerRef}>
            {visibleNodes.map((node: Node) => {
              const scaledSize = getScaledSize(node.id);
              const screenPos = getRelativePosition(node.id, scaledSize);
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
                  isHighlighted={portHighlightedNodeIds.has(node.id)}
                  isDimmed={isDimmed}
                  isOverview={isOverview}
                  onPositionChange={handlePositionChange}
                  onPositionCommit={handlePositionCommit}
                  onSelect={handleWindowSelect}
                  onPortMouseDown={handlePortMouseDown}
                  onPortClick={handlePortClick}
                  onDoubleClick={centerStage}
                  onContextMenu={handleNodeContextMenu}
                  onMessage={onNodeMessage}
                  zoom={viewport.zoom}
                  artifacts={run.artifacts ? Object.values(run.artifacts).filter(a => a.nodeId === node.id) : []}
                  onStopNode={onStopNode}
                  onRestartNode={onRestartNode}
                  isFocused={selectedNodeId === node.id && viewport.zoom > 0.8}
                />
              );
            })}
          </div>
        )}

        {newEdgeDrag && (() => {
          const sourcePort = getPortPosition(newEdgeDrag.sourceId, newEdgeDrag.sourcePort);
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
              <marker
                id="vuhlp-edge-drag-arrow-disconnect"
                markerWidth="8"
                markerHeight="6"
                refX="7"
                refY="3"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M0,0 L8,3 L0,6 Z" fill="#ef4444" />
              </marker>
            </defs>
            <path
              className={`vuhlp-graph__edge-drag ${!edgeDrag?.isOverValidTarget ? 'vuhlp-graph__edge-drag--disconnect' : ''}`}
              d={buildEdgePath(edgeDragPoints.source, edgeDragPoints.target, connectionStyle)}
              markerEnd={edgeDrag?.isOverValidTarget ? 'url(#vuhlp-edge-drag-arrow)' : 'url(#vuhlp-edge-drag-arrow-disconnect)'}
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

        {portTooltip && (() => {
          const position = getPortPosition(portTooltip.nodeId, portTooltip.port);
          if (!position) return null;

          // Filter edges connected to this port
          const connectedEdges = edges.filter((edge) => {
            if (portTooltip.port === 'output') {
              return edge.source === portTooltip.nodeId;
            } else {
              return edge.target === portTooltip.nodeId;
            }
          });

          if (connectedEdges.length === 0) return null;

          return (
             <div
              className="vuhlp-graph__edge-tooltip"
              style={{ left: position.x + 12, top: position.y + 12 }}
            >
              <div className="vuhlp-graph__edge-tooltip-title">
                {portTooltip.port === 'output' ? 'Outbound Connections' : 'Inbound Connections'}
              </div>
              <div className="vuhlp-graph__edge-tooltip-meta">
                {connectedEdges.map((edge) => {
                   const otherNodeId = portTooltip.port === 'output' ? edge.target : edge.source;
                   const label = nodeLabelRef.current[otherNodeId] || otherNodeId;
                   return (
                     <div key={edge.id}>
                       {portTooltip.port === 'output' ? '-> ' : '<- '} {label}
                     </div>
                   );
                })}
              </div>
            </div>
          );
        })()}
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

      {/* Shortcuts Info Tooltip */}
      {showInfo && (
        <div className="vuhlp-graph__shortcuts-tooltip">
          <div className="vuhlp-graph__shortcuts-title">Keyboard Shortcuts</div>
          <div className="vuhlp-graph__shortcuts-list">
             <div className="vuhlp-graph__shortcut-item">
                <span className="vuhlp-graph__shortcut-label">Zoom</span>
                <span className="vuhlp-graph__shortcut-keys">
                   <kbd>Ctrl</kbd> + <kbd>Scroll</kbd>
                </span>
             </div>
             <div className="vuhlp-graph__shortcut-item">
                <span className="vuhlp-graph__shortcut-label">Pan</span>
                <span className="vuhlp-graph__shortcut-keys">
                   <kbd>Scroll</kbd> / <kbd>Drag</kbd>
                </span>
             </div>
             <div className="vuhlp-graph__shortcut-item">
                <span className="vuhlp-graph__shortcut-label">Select Node</span>
                <span className="vuhlp-graph__shortcut-keys">
                   <kbd>Click</kbd>
                </span>
             </div>
             <div className="vuhlp-graph__shortcut-item">
                <span className="vuhlp-graph__shortcut-label">Center Stage</span>
                <span className="vuhlp-graph__shortcut-keys">
                    <kbd>Double Click</kbd> / <kbd>f</kbd>
                </span>
             </div>
             <div className="vuhlp-graph__shortcut-item">
                <span className="vuhlp-graph__shortcut-label">Cycle Inputs</span>
                <span className="vuhlp-graph__shortcut-keys">
                   <kbd>i</kbd>
                </span>
             </div>
             <div className="vuhlp-graph__shortcut-item">
                <span className="vuhlp-graph__shortcut-label">Cycle Outputs</span>
                <span className="vuhlp-graph__shortcut-keys">
                   <kbd>o</kbd>
                </span>
             </div>
             <div className="vuhlp-graph__shortcut-item">
                <span className="vuhlp-graph__shortcut-label">Duplicate Agent</span>
                <span className="vuhlp-graph__shortcut-keys">
                   <kbd>Shift</kbd> + <kbd>D</kbd>
                </span>
             </div>
             <div className="vuhlp-graph__shortcut-item">
                <span className="vuhlp-graph__shortcut-label">Delete Agent</span>
                <span className="vuhlp-graph__shortcut-keys">
                   <kbd>Shift</kbd> + <kbd>Q</kbd>
                </span>
             </div>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="vuhlp-graph__context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="vuhlp-graph__context-menu-item"
            onClick={() => handleDuplicateAgent()}
            disabled={!onNodeDuplicate}
          >
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6z"/>
              <path d="M2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1H2z"/>
            </svg>
            Duplicate Agent
            <span className="vuhlp-graph__context-menu-shortcut">Shift+D</span>
          </button>
          <div className="vuhlp-graph__context-menu-divider" />
          <button
            className="vuhlp-graph__context-menu-item vuhlp-graph__context-menu-item--danger"
            onClick={handleDeleteAgent}
            disabled={!onNodeDelete}
          >
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
              <path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
            </svg>
            Delete Agent
          </button>
        </div>
      )}

      {/* Edge Context Menu */}
      {edgeContextMenu && (
        <div
          className="vuhlp-graph__context-menu"
          style={{ left: edgeContextMenu.x, top: edgeContextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="vuhlp-graph__context-menu-header">
            {edgeContextMenu.sourceLabel} {edgeContextMenu.bidirectional ? '↔' : '→'} {edgeContextMenu.targetLabel}
          </div>
          <div className="vuhlp-graph__context-menu-divider" />
          <button
            className="vuhlp-graph__context-menu-item"
            onClick={() => {
              onEdgeUpdate?.(edgeContextMenu.edgeId, { bidirectional: !edgeContextMenu.bidirectional });
              setEdgeContextMenu(null);
            }}
            disabled={!onEdgeUpdate}
          >
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M1 11.5a.5.5 0 0 0 .5.5h11.793l-3.147 3.146a.5.5 0 0 0 .708.708l4-4a.5.5 0 0 0 0-.708l-4-4a.5.5 0 0 0-.708.708L13.293 11H1.5a.5.5 0 0 0-.5.5zm14-7a.5.5 0 0 0-.5-.5H2.707l3.147-3.146a.5.5 0 1 0-.708-.708l-4 4a.5.5 0 0 0 0 .708l4 4a.5.5 0 0 0 .708-.708L2.707 4H14.5a.5.5 0 0 0 .5-.5z"/>
            </svg>
            {edgeContextMenu.bidirectional ? 'Make Directional (One-Way)' : 'Make Bidirectional'}
          </button>
          {!edgeContextMenu.bidirectional && (
            <>
              <div className="vuhlp-graph__context-menu-divider" />
              <button
                className="vuhlp-graph__context-menu-item"
                onClick={() => {
                   onEdgeUpdate?.(edgeContextMenu.edgeId, { 
                     source: edgeContextMenu.targetId,
                     target: edgeContextMenu.sourceId,
                   });
                   setEdgeContextMenu(null);
                }}
                disabled={!onEdgeUpdate}
              >
               <svg viewBox="0 0 16 16" fill="currentColor">
                  <path fillRule="evenodd" d="M11.5 15a.5.5 0 0 0 .5-.5V2.707l3.146 3.147a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 1 0 .708.708L11 2.707V14.5a.5.5 0 0 0 .5.5zm-7-14a.5.5 0 0 1 .5.5v11.793l3.146-3.147a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 .708-.708L4 13.293V1.5a.5.5 0 0 1 .5-.5z"/>
               </svg>
               Flip Direction
              </button>
            </>
          )}
          {!edgeContextMenu.bidirectional && (
            <>
              <div className="vuhlp-graph__context-menu-divider" />
              <button
                className="vuhlp-graph__context-menu-item"
                onClick={() => {
                  // Flip direction: Swap source and target
                  // Note: The backend/provider needs to handle this update properly
                  // For the UI, we just flip the IDs
                   onEdgeUpdate?.(edgeContextMenu.edgeId, { 
                     source: edgeContextMenu.targetId, // We don't have IDs here directly in prop, need to fetch from edge?
                     // Ah, edgeContextMenu only has string labels? 
                     // Wait, looking at ContextMenuState definition... 
                     // It has edgeId. I don't have sourceId/targetId in the state object.
                     // I need to update where setEdgeContextMenu is called to include IDs.
                   });
                   // Actually, checking lines 2595-2630...
                   // The state `EdgeContextMenuState` (lines 280-287) has: 
                   // edgeId, sourceLabel, targetLabel, bidirectional.
                   // It MISSES sourceId and targetId.
                   // I cannot implement this without those IDs. 
                   // I will ABORT this chunk and update the definition first or fetching logic.
                   setEdgeContextMenu(null);
                }}
                disabled={true} 
              >
               <svg viewBox="0 0 16 16" fill="currentColor">
                  <path fillRule="evenodd" d="M11.5 15a.5.5 0 0 0 .5-.5V2.707l3.146 3.147a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 1 0 .708.708L11 2.707V14.5a.5.5 0 0 0 .5.5zm-7-14a.5.5 0 0 1 .5.5v11.793l3.146-3.147a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 .708-.708L4 13.293V1.5a.5.5 0 0 1 .5-.5z"/>
               </svg>
               Flip Direction
              </button>
            </>
          )}
          <div className="vuhlp-graph__context-menu-divider" />
          <button
            className="vuhlp-graph__context-menu-item vuhlp-graph__context-menu-item--danger"
            onClick={handleRemoveEdge}
            disabled={!onEdgeDelete}
          >
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
            </svg>
            Remove Edge
          </button>
        </div>
      )}

      {/* Canvas Context Menu (Add Agent) */}
      {canvasContextMenu && (
        <div
          className="vuhlp-graph__context-menu"
          style={{ left: canvasContextMenu.x, top: canvasContextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="vuhlp-graph__context-menu-item"
            onClick={() => {
              setAddAgentModal({ ...addAgentModal, open: true, label: '', customSystemPrompt: '', useCustomPrompt: false });
              setCanvasContextMenu(null);
            }}
          >
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2Z"/>
            </svg>
            Add Agent
          </button>
        </div>
      )}

      {/* Add Agent Modal */}
      {addAgentModal.open && (
        <div
          className="vuhlp-graph__modal-overlay"
          onClick={() => setAddAgentModal({ ...addAgentModal, open: false })}
        >
          <div
            className="vuhlp-graph__modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="vuhlp-graph__modal-header">
              <h3>Add Agent</h3>
              <button
                className="vuhlp-graph__modal-close"
                onClick={() => setAddAgentModal({ ...addAgentModal, open: false })}
              >
                &times;
              </button>
            </div>
            <div className="vuhlp-graph__modal-body">
              <div className="vuhlp-graph__modal-field">
                <label htmlFor="agent-label">Label</label>
                <input
                  id="agent-label"
                  type="text"
                  placeholder="Enter agent label..."
                  value={addAgentModal.label}
                  onChange={(e) => setAddAgentModal({ ...addAgentModal, label: e.target.value })}
                  autoFocus
                />
              </div>
              <div className="vuhlp-graph__modal-field">
                <label htmlFor="agent-provider">Provider</label>
                <select
                  id="agent-provider"
                  value={addAgentModal.providerId}
                  onChange={(e) => setAddAgentModal({ ...addAgentModal, providerId: e.target.value })}
                >
                  {PROVIDER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="vuhlp-graph__modal-field vuhlp-graph__modal-field--checkbox">
                <label>
                  <input
                    type="checkbox"
                    checked={addAgentModal.useCustomPrompt}
                    onChange={(e) => setAddAgentModal({ ...addAgentModal, useCustomPrompt: e.target.checked })}
                  />
                  Use Custom System Prompt
                </label>
              </div>
              {addAgentModal.useCustomPrompt ? (
                <div className="vuhlp-graph__modal-field">
                  <label htmlFor="agent-prompt">Custom System Prompt</label>
                  <textarea
                    id="agent-prompt"
                    placeholder="Enter custom system prompt..."
                    value={addAgentModal.customSystemPrompt}
                    onChange={(e) => setAddAgentModal({ ...addAgentModal, customSystemPrompt: e.target.value })}
                    rows={6}
                  />
                </div>
              ) : (
                <div className="vuhlp-graph__modal-field">
                  <label htmlFor="agent-role">Role</label>
                  <select
                    id="agent-role"
                    value={addAgentModal.role}
                    onChange={(e) => setAddAgentModal({ ...addAgentModal, role: e.target.value })}
                  >
                    <option value="investigator">Investigator</option>
                    <option value="planner">Planner</option>
                    <option value="implementer">Implementer</option>
                    <option value="reviewer">Reviewer</option>
                  </select>
                </div>
              )}
            </div>
            <div className="vuhlp-graph__modal-footer">
              <button
                className="vuhlp-graph__modal-btn vuhlp-graph__modal-btn--secondary"
                onClick={() => setAddAgentModal({ ...addAgentModal, open: false })}
              >
                Cancel
              </button>
              <button
                className="vuhlp-graph__modal-btn vuhlp-graph__modal-btn--primary"
                onClick={() => {
                  if (onNodeCreate) {
                    const options = addAgentModal.useCustomPrompt
                      ? { customSystemPrompt: addAgentModal.customSystemPrompt }
                      : { role: addAgentModal.role };
                    onNodeCreate(
                      addAgentModal.providerId,
                      addAgentModal.label || 'New Agent',
                      options
                    );
                  }
                  setAddAgentModal({ ...addAgentModal, open: false });
                }}
                disabled={!onNodeCreate}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
