import { create } from 'zustand';
import type {
  GraphLayout,
  RunState,
  NodeState,
  EdgeState,
  ISO8601,
  ToolCall,
  ToolCompletedEvent,
  TurnStatus,
  UUID,
  Envelope,
  ChatMessage,
  ToolEvent,
} from '@vuhlp/contracts';
import {
  appendAssistantDelta,
  finalizeAssistantMessage,
  appendAssistantThinkingDelta,
  finalizeAssistantThinking,
  finalizeNodeMessages,
  clearNodeMessages,
} from '@vuhlp/shared';
import { createLocalId } from '@/lib/ids';

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



export interface TurnStatusEvent {
  id: UUID;
  nodeId: UUID;
  status: TurnStatus;
  detail?: string;
  timestamp: ISO8601;
}

export interface PendingApproval {
  id: string;
  nodeId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  context?: string;
  timestamp: ISO8601;
}

interface GraphState {
  // Data
  run: RunState | null;
  nodes: VisualNode[];
  edges: VisualEdge[];
  viewport: Viewport;
  layoutUpdatedAt: ISO8601 | null;
  layoutDirty: boolean;
  viewDimensions: Dimensions;

  // Selection
  selectedNodeId: string | null;
  selectedEdgeId: string | null;

  // Edge creation
  edgeDrag: EdgeDragState | null;

  // Chat
  chatMessages: Record<UUID, ChatMessage[]>;
  toolEvents: ToolEvent[];
  turnStatusEvents: TurnStatusEvent[];

  // Approvals
  pendingApprovals: PendingApproval[];
  recentHandoffs: Envelope[];

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
  setViewDimensions: (dimensions: Dimensions) => void;
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
  updateChatMessageStatus: (
    nodeId: UUID,
    messageId: string,
    updates: Partial<Pick<ChatMessage, 'pending' | 'sendError'>>
  ) => void;
  appendAssistantDelta: (nodeId: UUID, delta: string, timestamp: ISO8601) => void;
  finalizeAssistantMessage: (
    nodeId: UUID,
    content: string,
    timestamp: ISO8601,
    status?: ChatMessage['status'],
    id?: string
  ) => void;
  appendAssistantThinkingDelta: (nodeId: UUID, delta: string, timestamp: ISO8601) => void;
  finalizeAssistantThinking: (nodeId: UUID, content: string, timestamp: ISO8601) => void;
  clearNodeMessages: (nodeId: UUID) => void;
  finalizeNodeMessages: (nodeId: UUID, timestamp: ISO8601) => void;

  // Tool + status events
  addToolEvent: (event: ToolEvent) => void;
  updateToolEvent: (toolId: UUID, update: Partial<ToolEvent>) => void;
  addTurnStatusEvent: (event: TurnStatusEvent) => void;

  // Approvals
  addApproval: (approval: PendingApproval) => void;
  removeApproval: (approvalId: string) => void;

  // Handoffs
  addHandoff: (envelope: Envelope) => void;

  // UI
  setInspectorOpen: (open: boolean) => void;

  // Reset
  reset: () => void;
}

const DEFAULT_NODE_DIMENSIONS: Dimensions = { width: 240, height: 120 };
const DEFAULT_ORIGIN: Point = { x: 100, y: 100 };
const DEFAULT_SPACING = { x: 280, y: 160 };
const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

function defaultPosition(index: number): Point {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return {
    x: DEFAULT_ORIGIN.x + col * DEFAULT_SPACING.x,
    y: DEFAULT_ORIGIN.y + row * DEFAULT_SPACING.y,
  };
}

function isLayoutNewer(layout: GraphLayout, currentUpdatedAt: ISO8601 | null): boolean {
  if (!currentUpdatedAt) return true;
  const incomingTime = Date.parse(layout.updatedAt);
  const currentTime = Date.parse(currentUpdatedAt);
  if (Number.isNaN(incomingTime) || Number.isNaN(currentTime)) {
    console.warn('[graph-store] invalid layout timestamp comparison', {
      incoming: layout.updatedAt,
      current: currentUpdatedAt,
    });
    return true;
  }
  return incomingTime >= currentTime;
}

function layoutMatchesState(
  layout: GraphLayout,
  nodes: VisualNode[],
  viewport: Viewport
): boolean {
  if (
    layout.viewport.x !== viewport.x ||
    layout.viewport.y !== viewport.y ||
    layout.viewport.zoom !== viewport.zoom
  ) {
    return false;
  }
  for (const node of nodes) {
    const position = layout.positions[node.id];
    if (!position) return false;
    if (position.x !== node.position.x || position.y !== node.position.y) {
      return false;
    }
  }
  return true;
}

function buildVisualNodes(
  run: RunState,
  existingNodes: Map<string, VisualNode>,
  selectedNodeId: string | null,
  layoutPositions: Record<string, Point> | null,
  shouldApplyLayout: boolean
): VisualNode[] {
  const runNodes = Object.values(run.nodes);
  return runNodes.map((node, index) => {
    const existing = existingNodes.get(node.id);
    const isSelected = node.id === selectedNodeId;
    const layoutPosition = layoutPositions?.[node.id];
    const position = shouldApplyLayout
      ? layoutPosition ?? existing?.position ?? defaultPosition(index)
      : existing?.position ?? layoutPosition ?? defaultPosition(index);
    const dimensions = existing?.dimensions ?? DEFAULT_NODE_DIMENSIONS;

    const positionMatches =
      existing?.position?.x === position.x && existing.position?.y === position.y;
    const dimensionsMatches =
      existing?.dimensions?.width === dimensions.width &&
      existing.dimensions?.height === dimensions.height;

    if (
      existing &&
      existing.selected === isSelected &&
      existing.status === node.status &&
      existing.label === node.label &&
      existing.summary === node.summary &&
      existing.lastActivityAt === node.lastActivityAt &&
      existing.roleTemplate === node.roleTemplate &&
      existing.provider === node.provider &&
      existing.capabilities === node.capabilities &&
      existing.permissions === node.permissions &&
      existing.session === node.session &&
      existing.inboxCount === node.inboxCount &&
      existing.todos === node.todos &&
      positionMatches &&
      dimensionsMatches
    ) {
      return existing;
    }

    return {
      ...node,
      position,
      dimensions,
      selected: isSelected,
    };
  });
}

function buildVisualEdges(
  run: RunState,
  existingEdges: Map<string, VisualEdge>,
  selectedEdgeId: string | null
): VisualEdge[] {
  return Object.values(run.edges).map((edge) => {
    const existing = existingEdges.get(edge.id);
    const isSelected = edge.id === selectedEdgeId;

    if (
      existing &&
      existing.selected === isSelected &&
      existing.from === edge.from &&
      existing.to === edge.to &&
      existing.bidirectional === edge.bidirectional &&
      existing.type === edge.type &&
      existing.label === edge.label
    ) {
      return existing;
    }

    return {
      ...edge,
      selected: isSelected,
    };
  });
}

const initialState = {
  run: null,
  nodes: [] as VisualNode[],
  edges: [] as VisualEdge[],
  viewport: DEFAULT_VIEWPORT,
  viewDimensions: { width: 0, height: 0 },
  layoutUpdatedAt: null as ISO8601 | null,
  layoutDirty: false,
  selectedNodeId: null,
  selectedEdgeId: null,
  edgeDrag: null,
  chatMessages: {} as Record<UUID, ChatMessage[]>,
  toolEvents: [],
  turnStatusEvents: [],
  pendingApprovals: [] as PendingApproval[],
  recentHandoffs: [] as Envelope[],
  inspectorOpen: false,
};

export const useGraphStore = create<GraphState>((set, get) => ({
  ...initialState,

  setRun: (run) => {
    const state = get();
    const runChanged = state.run?.id !== run.id;
    const existingNodes = runChanged ? new Map() : new Map(state.nodes.map((n) => [n.id, n]));
    const existingEdges = runChanged ? new Map() : new Map(state.edges.map((e) => [e.id, e]));
    const incomingLayout = run.layout ?? null;
    const layoutMatchesLocal = incomingLayout
      ? layoutMatchesState(incomingLayout, state.nodes, state.viewport)
      : false;
    const shouldApplyLayout = incomingLayout
      ? runChanged ||
      isLayoutNewer(incomingLayout, state.layoutUpdatedAt) ||
      (state.layoutDirty && layoutMatchesLocal)
      : false;
    const runNodes = Object.values(run.nodes);
    const layoutPositions = incomingLayout?.positions ?? {};
    const missingPositions = runNodes.some((node) => !layoutPositions[node.id]);
    const markDirty = missingPositions && !state.layoutDirty;
    const now = new Date().toISOString();
    set({
      run,
      nodes: buildVisualNodes(
        run,
        existingNodes,
        state.selectedNodeId,
        incomingLayout?.positions ?? null,
        shouldApplyLayout
      ),
      edges: buildVisualEdges(run, existingEdges, state.selectedEdgeId),
      viewport: shouldApplyLayout
        ? incomingLayout?.viewport ?? state.viewport
        : (runChanged ? DEFAULT_VIEWPORT : state.viewport),
      layoutUpdatedAt: markDirty
        ? now
        : (shouldApplyLayout
          ? incomingLayout?.updatedAt ?? state.layoutUpdatedAt
          : (runChanged ? null : state.layoutUpdatedAt)),
      layoutDirty: markDirty ? true : (shouldApplyLayout ? false : (runChanged ? false : state.layoutDirty)),
    });
  },

  applyRunPatch: (patch) => {
    const state = get();
    if (!state.run) return;
    const updatedRun = {
      ...state.run,
      ...patch,
      nodes: patch.nodes ? { ...state.run.nodes, ...patch.nodes } : state.run.nodes,
      nodeConfigs: patch.nodeConfigs
        ? { ...(state.run.nodeConfigs ?? {}), ...patch.nodeConfigs }
        : state.run.nodeConfigs,
      edges: patch.edges ? { ...state.run.edges, ...patch.edges } : state.run.edges,
      artifacts: patch.artifacts ? { ...state.run.artifacts, ...patch.artifacts } : state.run.artifacts,
    };
    const runChanged = updatedRun.id !== state.run.id;
    const existingNodes = runChanged ? new Map() : new Map(state.nodes.map((n) => [n.id, n]));
    const existingEdges = runChanged ? new Map() : new Map(state.edges.map((e) => [e.id, e]));
    const incomingLayout = updatedRun.layout ?? null;
    const layoutMatchesLocal = incomingLayout
      ? layoutMatchesState(incomingLayout, state.nodes, state.viewport)
      : false;
    const shouldApplyLayout = incomingLayout
      ? runChanged ||
      isLayoutNewer(incomingLayout, state.layoutUpdatedAt) ||
      (state.layoutDirty && layoutMatchesLocal)
      : false;
    const runNodes = Object.values(updatedRun.nodes);
    const layoutPositions = incomingLayout?.positions ?? {};
    const missingPositions = runNodes.some((node) => !layoutPositions[node.id]);
    const markDirty = missingPositions && !state.layoutDirty;
    const now = new Date().toISOString();
    set({
      run: updatedRun,
      nodes: buildVisualNodes(
        updatedRun,
        existingNodes,
        state.selectedNodeId,
        incomingLayout?.positions ?? null,
        shouldApplyLayout
      ),
      edges: buildVisualEdges(updatedRun, existingEdges, state.selectedEdgeId),
      viewport: shouldApplyLayout
        ? incomingLayout?.viewport ?? state.viewport
        : (runChanged ? DEFAULT_VIEWPORT : state.viewport),
      layoutUpdatedAt: markDirty
        ? now
        : (shouldApplyLayout
          ? incomingLayout?.updatedAt ?? state.layoutUpdatedAt
          : (runChanged ? null : state.layoutUpdatedAt)),
      layoutDirty: markDirty ? true : (shouldApplyLayout ? false : (runChanged ? false : state.layoutDirty)),
    });
  },

  addNode: (node) => {
    const now = new Date().toISOString();
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
        layoutUpdatedAt: now,
        layoutDirty: true,
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
    const now = new Date().toISOString();
    set((state) => {
      if (!state.run) return state;
      const { [nodeId]: _, ...remainingNodes } = state.run.nodes;
      const isSelected = state.selectedNodeId === nodeId;
      return {
        run: { ...state.run, nodes: remainingNodes },
        nodes: state.nodes.filter((n) => n.id !== nodeId),
        selectedNodeId: isSelected ? null : state.selectedNodeId,
        inspectorOpen: isSelected ? false : state.inspectorOpen,
        layoutUpdatedAt: now,
        layoutDirty: true,
      };
    });
  },

  addEdge: (edge) => {
    set((state) => {
      if (!state.run) return state;
      // Prevent duplicate edges (e.g. race between API response and sync)
      if (state.run.edges[edge.id]) return state;

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
      const wasSelected = state.selectedEdgeId === edgeId;
      return {
        run: { ...state.run, edges: remainingEdges },
        edges: state.edges.filter((e) => e.id !== edgeId),
        selectedEdgeId: wasSelected ? null : state.selectedEdgeId,
        inspectorOpen: wasSelected ? state.selectedNodeId !== null : state.inspectorOpen,
      };
    });
  },

  setViewport: (viewport) => {
    const now = new Date().toISOString();
    set({ viewport, layoutUpdatedAt: now, layoutDirty: true });
  },

  setViewDimensions: (viewDimensions) => set({ viewDimensions }),

  panBy: (dx, dy) => {
    const now = new Date().toISOString();
    set((state) => ({
      viewport: {
        ...state.viewport,
        x: state.viewport.x + dx,
        y: state.viewport.y + dy,
      },
      layoutUpdatedAt: now,
      layoutDirty: true,
    }));
  },

  zoomTo: (zoom, focalPoint) => {
    const now = new Date().toISOString();
    set((state) => {
      const clampedZoom = Math.max(0.25, Math.min(zoom, 4));
      if (!focalPoint) {
        return { viewport: { ...state.viewport, zoom: clampedZoom }, layoutUpdatedAt: now, layoutDirty: true };
      }
      const ratio = clampedZoom / state.viewport.zoom;
      const newX = focalPoint.x - (focalPoint.x - state.viewport.x) * ratio;
      const newY = focalPoint.y - (focalPoint.y - state.viewport.y) * ratio;
      return { viewport: { x: newX, y: newY, zoom: clampedZoom }, layoutUpdatedAt: now, layoutDirty: true };
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
      inspectorOpen: edgeId ? true : state.selectedNodeId !== null,
    }));
  },

  updateNodePosition: (nodeId, x, y) => {
    set((state) => {
      let found = false;
      let changed = false;
      const nodes = state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        found = true;
        if (n.position.x === x && n.position.y === y) {
          return n;
        }
        changed = true;
        return { ...n, position: { x, y } };
      });
      if (!found) {
        console.warn('[graph-store] updateNodePosition: node not found', { nodeId });
        return state;
      }
      if (!changed) {
        return state;
      }
      const now = new Date().toISOString();
      return {
        nodes,
        layoutUpdatedAt: now,
        layoutDirty: true,
      };
    });
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
      const existingIdIndex = existing.findIndex((item) => item.id === message.id);
      if (existingIdIndex >= 0) {
        const next = [...existing];
        next[existingIdIndex] = { ...existing[existingIdIndex], ...message };
        return {
          chatMessages: {
            ...state.chatMessages,
            [message.nodeId]: next,
          },
        };
      }

      const isLocal = message.id.startsWith('local-');
      if (!isLocal) {
        const matchIndex = existing.findIndex((item) => {
          if (!item.id.startsWith('local-')) return false;
          if (item.role !== message.role) return false;
          if (item.content.trim() !== message.content.trim()) return false;
          const existingTime = Date.parse(item.createdAt);
          const messageTime = Date.parse(message.createdAt);
          if (Number.isNaN(existingTime) || Number.isNaN(messageTime)) return false;
          return Math.abs(existingTime - messageTime) < 10000;
        });
        if (matchIndex >= 0) {
          const next = [...existing];
          next[matchIndex] = { ...message };
          return {
            chatMessages: {
              ...state.chatMessages,
              [message.nodeId]: next,
            },
          };
        }
      }
      return {
        chatMessages: {
          ...state.chatMessages,
          [message.nodeId]: [...existing, message],
        },
      };
    });
  },

  updateChatMessageStatus: (nodeId, messageId, updates) =>
    set((state) => {
      const messages = state.chatMessages[nodeId];
      if (!messages) return state;
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) return state;
      const next = [...messages];
      if (!next[index]) return state;
      next[index] = { ...next[index], ...updates };
      return {
        chatMessages: {
          ...state.chatMessages,
          [nodeId]: next,
        },
      };
    }),

  appendAssistantDelta: (nodeId, delta, timestamp) =>
    set((state) => {
      const messages = state.chatMessages[nodeId] ?? [];
      return {
        chatMessages: {
          ...state.chatMessages,
          [nodeId]: appendAssistantDelta(messages, nodeId, delta, timestamp),
        },
      };
    }),

  finalizeAssistantMessage: (nodeId, content, timestamp, status, id) =>
    set((state) => {
      const messages = state.chatMessages[nodeId] ?? [];
      return {
        chatMessages: {
          ...state.chatMessages,
          [nodeId]: finalizeAssistantMessage(messages, nodeId, content, timestamp, status, id),
        },
      };
    }),

  appendAssistantThinkingDelta: (nodeId, delta, timestamp) =>
    set((state) => {
      const messages = state.chatMessages[nodeId] ?? [];
      return {
        chatMessages: {
          ...state.chatMessages,
          [nodeId]: appendAssistantThinkingDelta(messages, nodeId, delta, timestamp),
        },
      };
    }),

  finalizeAssistantThinking: (nodeId, content, timestamp) =>
    set((state) => {
      const messages = state.chatMessages[nodeId] ?? [];
      return {
        chatMessages: {
          ...state.chatMessages,
          [nodeId]: finalizeAssistantThinking(messages, nodeId, content, timestamp),
        },
      };
    }),

  finalizeNodeMessages: (nodeId, timestamp) =>
    set((state) => {
      const messages = state.chatMessages[nodeId] ?? [];
      return {
        chatMessages: {
          ...state.chatMessages,
          [nodeId]: finalizeNodeMessages(messages, timestamp),
        },
      };
    }),

  clearNodeMessages: (nodeId) =>
    set((state) => {
      if (!state.chatMessages[nodeId]) {
        return state;
      }
      return {
        chatMessages: clearNodeMessages(state.chatMessages, nodeId),
      };
    }),

  addHandoff: (envelope) =>
    set((state) => ({
      recentHandoffs: [envelope, ...state.recentHandoffs].slice(0, 50),
    })),

  addToolEvent: (event) =>
    set((state) => ({
      toolEvents: [...state.toolEvents, event].slice(-100),
    })),

  updateToolEvent: (toolId, update) =>
    set((state) => ({
      toolEvents: state.toolEvents.map((event) =>
        event.tool.id === toolId ? { ...event, ...update } : event
      ),
    })),

  addTurnStatusEvent: (event) =>
    set((state) => ({
      turnStatusEvents: [...state.turnStatusEvents, event].slice(-200),
    })),

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
