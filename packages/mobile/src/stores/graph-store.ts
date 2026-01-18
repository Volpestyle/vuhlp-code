import { create } from 'zustand';
import type { RunState, NodeState, EdgeState, ApprovalRequestedEvent } from '@vuhlp/contracts';

export interface Point {
  x: number;
  y: number;
}

export interface Dimensions {
  width: number;
  height: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface VisualNode extends NodeState {
  position: Point;
  dimensions: Dimensions;
  selected: boolean;
}

export interface VisualEdge extends EdgeState {
  selected: boolean;
}

export interface EdgeDragState {
  fromNodeId: string;
  fromPortIndex: number;
  currentPoint: Point;
}

export interface ChatMessage {
  id: string;
  nodeId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  streaming?: boolean;
}

export interface PendingApproval {
  id: string;
  nodeId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  context?: string;
  timestamp: string;
}

interface GraphState {
  // Data
  run: RunState | null;
  nodes: VisualNode[];
  edges: VisualEdge[];
  viewport: Viewport;

  // Selection
  selectedNodeId: string | null;
  selectedEdgeId: string | null;

  // Edge creation
  edgeDrag: EdgeDragState | null;

  // Chat
  chatMessages: Record<string, ChatMessage[]>;
  streamingContent: Record<string, string>;

  // Approvals
  pendingApprovals: PendingApproval[];

  // UI
  inspectorOpen: boolean;

  // Actions
  setRun: (run: RunState) => void;
  applyRunPatch: (patch: Partial<RunState>) => void;
  addNode: (node: NodeState) => void;
  updateNode: (nodeId: string, patch: Partial<NodeState>) => void;
  removeNode: (nodeId: string) => void;
  addEdge: (edge: EdgeState) => void;
  removeEdge: (edgeId: string) => void;

  // Viewport
  setViewport: (viewport: Viewport) => void;
  panBy: (dx: number, dy: number) => void;
  zoomTo: (zoom: number, focalPoint?: Point) => void;

  // Selection
  selectNode: (nodeId: string | null) => void;
  selectEdge: (edgeId: string | null) => void;

  // Node positioning
  updateNodePosition: (nodeId: string, x: number, y: number) => void;

  // Edge creation
  startEdgeDrag: (fromNodeId: string, fromPortIndex: number, point: Point) => void;
  updateEdgeDrag: (point: Point) => void;
  endEdgeDrag: () => void;

  // Chat
  addChatMessage: (message: ChatMessage) => void;
  appendStreamingContent: (nodeId: string, delta: string) => void;
  finalizeStreaming: (nodeId: string, content: string) => void;

  // Approvals
  addApproval: (approval: PendingApproval) => void;
  removeApproval: (approvalId: string) => void;

  // UI
  setInspectorOpen: (open: boolean) => void;

  // Reset
  reset: () => void;
}

const DEFAULT_NODE_DIMENSIONS: Dimensions = { width: 240, height: 120 };
const DEFAULT_ORIGIN: Point = { x: 100, y: 100 };
const DEFAULT_SPACING = { x: 280, y: 160 };

function defaultPosition(index: number): Point {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return {
    x: DEFAULT_ORIGIN.x + col * DEFAULT_SPACING.x,
    y: DEFAULT_ORIGIN.y + row * DEFAULT_SPACING.y,
  };
}

function buildVisualNodes(
  run: RunState,
  existingNodes: Map<string, VisualNode>,
  selectedNodeId: string | null
): VisualNode[] {
  const runNodes = Object.values(run.nodes);
  return runNodes.map((node, index) => {
    const existing = existingNodes.get(node.id);
    return {
      ...node,
      position: existing?.position ?? defaultPosition(index),
      dimensions: existing?.dimensions ?? DEFAULT_NODE_DIMENSIONS,
      selected: node.id === selectedNodeId,
    };
  });
}

function buildVisualEdges(run: RunState, selectedEdgeId: string | null): VisualEdge[] {
  return Object.values(run.edges).map((edge) => ({
    ...edge,
    selected: edge.id === selectedEdgeId,
  }));
}

const initialState = {
  run: null,
  nodes: [] as VisualNode[],
  edges: [] as VisualEdge[],
  viewport: { x: 0, y: 0, zoom: 1 },
  selectedNodeId: null,
  selectedEdgeId: null,
  edgeDrag: null,
  chatMessages: {} as Record<string, ChatMessage[]>,
  streamingContent: {} as Record<string, string>,
  pendingApprovals: [] as PendingApproval[],
  inspectorOpen: false,
};

export const useGraphStore = create<GraphState>((set, get) => ({
  ...initialState,

  setRun: (run) => {
    const state = get();
    const existingNodes = new Map(state.nodes.map((n) => [n.id, n]));
    set({
      run,
      nodes: buildVisualNodes(run, existingNodes, state.selectedNodeId),
      edges: buildVisualEdges(run, state.selectedEdgeId),
    });
  },

  applyRunPatch: (patch) => {
    const state = get();
    if (!state.run) return;
    const updatedRun = { ...state.run, ...patch };
    const existingNodes = new Map(state.nodes.map((n) => [n.id, n]));
    set({
      run: updatedRun,
      nodes: buildVisualNodes(updatedRun, existingNodes, state.selectedNodeId),
      edges: buildVisualEdges(updatedRun, state.selectedEdgeId),
    });
  },

  addNode: (node) => {
    set((state) => {
      if (!state.run) return state;
      if (state.run.nodes[node.id]) return state;
      const visualNode: VisualNode = {
        ...node,
        position: defaultPosition(state.nodes.length),
        dimensions: DEFAULT_NODE_DIMENSIONS,
        selected: false,
      };
      return {
        run: { ...state.run, nodes: { ...state.run.nodes, [node.id]: node } },
        nodes: [...state.nodes, visualNode],
      };
    });
  },

  updateNode: (nodeId, patch) => {
    set((state) => {
      if (!state.run) return state;
      const node = state.run.nodes[nodeId];
      if (!node) return state;
      const updatedNode = { ...node, ...patch };
      const updatedRun = {
        ...state.run,
        nodes: { ...state.run.nodes, [nodeId]: updatedNode },
      };
      return {
        run: updatedRun,
        nodes: state.nodes.map((n) =>
          n.id === nodeId ? { ...n, ...patch } : n
        ),
      };
    });
  },

  removeNode: (nodeId) => {
    set((state) => {
      if (!state.run) return state;
      const { [nodeId]: _, ...remainingNodes } = state.run.nodes;
      return {
        run: { ...state.run, nodes: remainingNodes },
        nodes: state.nodes.filter((n) => n.id !== nodeId),
        selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
      };
    });
  },

  addEdge: (edge) => {
    set((state) => {
      if (!state.run) return state;
      return {
        run: { ...state.run, edges: { ...state.run.edges, [edge.id]: edge } },
        edges: [...state.edges, { ...edge, selected: false }],
      };
    });
  },

  removeEdge: (edgeId) => {
    set((state) => {
      if (!state.run) return state;
      const { [edgeId]: _, ...remainingEdges } = state.run.edges;
      return {
        run: { ...state.run, edges: remainingEdges },
        edges: state.edges.filter((e) => e.id !== edgeId),
        selectedEdgeId: state.selectedEdgeId === edgeId ? null : state.selectedEdgeId,
      };
    });
  },

  setViewport: (viewport) => set({ viewport }),

  panBy: (dx, dy) => {
    set((state) => ({
      viewport: {
        ...state.viewport,
        x: state.viewport.x + dx,
        y: state.viewport.y + dy,
      },
    }));
  },

  zoomTo: (zoom, focalPoint) => {
    set((state) => {
      const clampedZoom = Math.max(0.25, Math.min(zoom, 4));
      if (!focalPoint) {
        return { viewport: { ...state.viewport, zoom: clampedZoom } };
      }
      const ratio = clampedZoom / state.viewport.zoom;
      const newX = focalPoint.x - (focalPoint.x - state.viewport.x) * ratio;
      const newY = focalPoint.y - (focalPoint.y - state.viewport.y) * ratio;
      return { viewport: { x: newX, y: newY, zoom: clampedZoom } };
    });
  },

  selectNode: (nodeId) => {
    set((state) => ({
      selectedNodeId: nodeId,
      selectedEdgeId: nodeId ? null : state.selectedEdgeId,
      nodes: state.nodes.map((n) => ({ ...n, selected: n.id === nodeId })),
      edges: state.edges.map((e) => ({ ...e, selected: false })),
      inspectorOpen: nodeId !== null,
    }));
  },

  selectEdge: (edgeId) => {
    set((state) => ({
      selectedEdgeId: edgeId,
      selectedNodeId: edgeId ? null : state.selectedNodeId,
      nodes: state.nodes.map((n) => ({ ...n, selected: false })),
      edges: state.edges.map((e) => ({ ...e, selected: e.id === edgeId })),
    }));
  },

  updateNodePosition: (nodeId, x, y) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, position: { x, y } } : n
      ),
    }));
  },

  // Edge creation
  startEdgeDrag: (fromNodeId, fromPortIndex, point) => {
    set({ edgeDrag: { fromNodeId, fromPortIndex, currentPoint: point } });
  },

  updateEdgeDrag: (point) => {
    set((state) => {
      if (!state.edgeDrag) return state;
      return { edgeDrag: { ...state.edgeDrag, currentPoint: point } };
    });
  },

  endEdgeDrag: () => {
    set({ edgeDrag: null });
  },

  // Chat
  addChatMessage: (message) => {
    set((state) => {
      const existing = state.chatMessages[message.nodeId] ?? [];
      return {
        chatMessages: {
          ...state.chatMessages,
          [message.nodeId]: [...existing, message],
        },
      };
    });
  },

  appendStreamingContent: (nodeId, delta) => {
    set((state) => ({
      streamingContent: {
        ...state.streamingContent,
        [nodeId]: (state.streamingContent[nodeId] ?? '') + delta,
      },
    }));
  },

  finalizeStreaming: (nodeId, content) => {
    set((state) => {
      const { [nodeId]: _, ...remainingStreaming } = state.streamingContent;
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        nodeId,
        role: 'assistant',
        content,
        timestamp: new Date().toISOString(),
      };
      const existing = state.chatMessages[nodeId] ?? [];
      return {
        streamingContent: remainingStreaming,
        chatMessages: {
          ...state.chatMessages,
          [nodeId]: [...existing, message],
        },
      };
    });
  },

  // Approvals
  addApproval: (approval) => {
    set((state) => ({
      pendingApprovals: [...state.pendingApprovals, approval],
    }));
  },

  removeApproval: (approvalId) => {
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((a) => a.id !== approvalId),
    }));
  },

  // UI
  setInspectorOpen: (open) => set({ inspectorOpen: open }),

  reset: () => set(initialState),
}));
