import { create } from 'zustand';
import type {
  RunState,
  NodeState,
  EdgeState,
  ISO8601,
  ToolCall,
  ToolCompletedEvent,
  TurnStatus,
  UUID,
} from '@vuhlp/contracts';
import { createLocalId } from '@/lib/ids';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isToolCallLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) {
    return false;
  }
  const container = isRecord(parsed.tool_call)
    ? parsed.tool_call
    : isRecord(parsed.toolCall)
      ? parsed.toolCall
      : null;
  if (container) {
    const name = typeof container.name === 'string' ? container.name.trim() : '';
    const args = isRecord(container.args)
      ? container.args
      : isRecord(container.params)
        ? container.params
        : null;
    return Boolean(name && args);
  }
  const directName =
    typeof parsed.tool === 'string'
      ? parsed.tool.trim()
      : typeof parsed.name === 'string'
        ? parsed.name.trim()
        : '';
  const directArgs = isRecord(parsed.args)
    ? parsed.args
    : isRecord(parsed.params)
      ? parsed.params
      : null;
  return Boolean(directName && directArgs);
};

const stripToolCallLines = (content: string): string => {
  if (!content) {
    return content;
  }
  const lines = content.split('\n');
  const kept = lines.filter((line) => !isToolCallLine(line));
  return kept.join('\n');
};

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
  nodeId: UUID;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: ISO8601;
  streaming?: boolean;
  status?: 'final' | 'interrupted';
  thinking?: string;
  thinkingStreaming?: boolean;
  pending?: boolean;
  sendError?: string;
  interrupt?: boolean;
  rawContent?: string;
}

export interface ToolEvent {
  id: UUID;
  nodeId: UUID;
  tool: ToolCall;
  status: 'proposed' | 'started' | 'completed' | 'failed';
  timestamp: ISO8601;
  result?: ToolCompletedEvent['result'];
  error?: ToolCompletedEvent['error'];
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

  // Tool + status events
  addToolEvent: (event: ToolEvent) => void;
  updateToolEvent: (toolId: UUID, update: Partial<ToolEvent>) => void;
  addTurnStatusEvent: (event: TurnStatusEvent) => void;

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
    const isSelected = node.id === selectedNodeId;

    // Return existing visual node if nothing changed
    if (
      existing &&
      existing.selected === isSelected &&
      existing.status === node.status &&
      existing.label === node.label &&
      existing.summary === node.summary &&
      existing.lastActivityAt === node.lastActivityAt &&
      existing.roleTemplate === node.roleTemplate &&
      existing.provider === node.provider &&
      // Check complex objects equality by reference (assuming immutable updates in contract)
      existing.capabilities === node.capabilities &&
      existing.permissions === node.permissions &&
      existing.session === node.session &&
      existing.inboxCount === node.inboxCount &&
      // Check visual properties
      existing.position &&
      existing.dimensions
    ) {
      return existing;
    }

    return {
      ...node,
      position: existing?.position ?? defaultPosition(index),
      dimensions: existing?.dimensions ?? DEFAULT_NODE_DIMENSIONS,
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
  viewport: { x: 0, y: 0, zoom: 1 },
  viewDimensions: { width: 0, height: 0 },
  selectedNodeId: null,
  selectedEdgeId: null,
  edgeDrag: null,
  chatMessages: {} as Record<UUID, ChatMessage[]>,
  toolEvents: [],
  turnStatusEvents: [],
  pendingApprovals: [] as PendingApproval[],
  inspectorOpen: false,
};

export const useGraphStore = create<GraphState>((set, get) => ({
  ...initialState,

  setRun: (run) => {
    const state = get();
    const existingNodes = new Map(state.nodes.map((n) => [n.id, n]));
    const existingEdges = new Map(state.edges.map((e) => [e.id, e]));
    set({
      run,
      nodes: buildVisualNodes(run, existingNodes, state.selectedNodeId),
      edges: buildVisualEdges(run, existingEdges, state.selectedEdgeId),
    });
  },

  applyRunPatch: (patch) => {
    const state = get();
    if (!state.run) return;
    const updatedRun = { ...state.run, ...patch };
    const existingNodes = new Map(state.nodes.map((n) => [n.id, n]));
    const existingEdges = new Map(state.edges.map((e) => [e.id, e]));
    set({
      run: updatedRun,
      nodes: buildVisualNodes(updatedRun, existingNodes, state.selectedNodeId),
      edges: buildVisualEdges(updatedRun, existingEdges, state.selectedEdgeId),
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
      const isSelected = state.selectedNodeId === nodeId;
      return {
        run: { ...state.run, nodes: remainingNodes },
        nodes: state.nodes.filter((n) => n.id !== nodeId),
        selectedNodeId: isSelected ? null : state.selectedNodeId,
        inspectorOpen: isSelected ? false : state.inspectorOpen,
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
      return {
        run: { ...state.run, edges: remainingEdges },
        edges: state.edges.filter((e) => e.id !== edgeId),
        selectedEdgeId: state.selectedEdgeId === edgeId ? null : state.selectedEdgeId,
      };
    });
  },

  setViewport: (viewport) => set({ viewport }),

  setViewDimensions: (viewDimensions) => set({ viewDimensions }),

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
      inspectorOpen: edgeId ? false : state.inspectorOpen,
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
      const streamId = `stream-${nodeId}`;
      const existingIndex = messages.findIndex((msg) => msg.id === streamId);
      if (existingIndex >= 0) {
        const existing = messages[existingIndex];
        if (!existing) return state;
        const rawContent = `${existing.rawContent ?? existing.content}${delta}`;
        const content = stripToolCallLines(rawContent);
        const next = [...messages];
        next[existingIndex] = {
          ...existing,
          content,
          rawContent,
          createdAt: timestamp,
          streaming: true,
        };
        return {
          chatMessages: { ...state.chatMessages, [nodeId]: next },
        };
      }
      const rawContent = delta;
      const content = stripToolCallLines(delta);
      const nextMessage: ChatMessage = {
        id: streamId,
        nodeId,
        role: 'assistant',
        content,
        rawContent,
        createdAt: timestamp,
        streaming: true,
      };
      return {
        chatMessages: {
          ...state.chatMessages,
          [nodeId]: [...messages, nextMessage],
        },
      };
    }),

  finalizeAssistantMessage: (nodeId, content, timestamp, status, id) =>
    set((state) => {
      const messages = state.chatMessages[nodeId] ?? [];
      const streamId = `stream-${nodeId}`;
      const thinkingStreamId = `thinking-stream-${nodeId}`;
      const hasExistingMessage = messages.some((message) => message.id === id);
      const filtered = messages.filter(
        (message) => message.id !== streamId && message.id !== thinkingStreamId
      );

      if (hasExistingMessage) {
        return {
          chatMessages: {
            ...state.chatMessages,
            [nodeId]: filtered,
          },
        };
      }

      const streamingMsg = messages.find((message) => message.id === streamId);
      const thinkingStreamingMsg = messages.find((message) => message.id === thinkingStreamId);
      const thinking = streamingMsg?.thinking ?? thinkingStreamingMsg?.thinking;

      const nextMessage: ChatMessage = {
        id: id ?? createLocalId(),
        nodeId,
        role: 'assistant',
        content,
        createdAt: timestamp,
        status,
        thinking,
      };
      return {
        chatMessages: {
          ...state.chatMessages,
          [nodeId]: [...filtered, nextMessage],
        },
      };
    }),

  appendAssistantThinkingDelta: (nodeId, delta, timestamp) =>
    set((state) => {
      const messages = state.chatMessages[nodeId] ?? [];
      const streamId = `stream-${nodeId}`;
      const existingStreamIndex = messages.findIndex((msg) => msg.id === streamId);

      if (existingStreamIndex >= 0) {
        const existing = messages[existingStreamIndex];
        if (!existing) return state;
        const next = [...messages];
        next[existingStreamIndex] = {
          ...existing,
          thinking: `${existing.thinking ?? ''}${delta}`,
          thinkingStreaming: true,
          createdAt: timestamp,
        };
        return {
          chatMessages: { ...state.chatMessages, [nodeId]: next },
        };
      }

      const thinkingStreamId = `thinking-stream-${nodeId}`;
      const existingThinkingIndex = messages.findIndex((msg) => msg.id === thinkingStreamId);

      if (existingThinkingIndex >= 0) {
        const existing = messages[existingThinkingIndex];
        if (!existing) return state;
        const next = [...messages];
        next[existingThinkingIndex] = {
          ...existing,
          thinking: `${existing.thinking ?? ''}${delta}`,
          thinkingStreaming: true,
          createdAt: timestamp,
        };
        return {
          chatMessages: { ...state.chatMessages, [nodeId]: next },
        };
      }

      const nextMessage: ChatMessage = {
        id: thinkingStreamId,
        nodeId,
        role: 'assistant',
        content: '',
        createdAt: timestamp,
        streaming: true,
        thinking: delta,
        thinkingStreaming: true,
      };
      return {
        chatMessages: {
          ...state.chatMessages,
          [nodeId]: [...messages, nextMessage],
        },
      };
    }),

  finalizeAssistantThinking: (nodeId, content, timestamp) =>
    set((state) => {
      const messages = state.chatMessages[nodeId] ?? [];
      const streamId = `stream-${nodeId}`;
      const thinkingStreamId = `thinking-stream-${nodeId}`;

      const streamIndex = messages.findIndex((msg) => msg.id === streamId);
      if (streamIndex >= 0) {
        const existing = messages[streamIndex];
        if (!existing) return state;
        const next = [...messages];
        next[streamIndex] = {
          ...existing,
          thinking: content,
          thinkingStreaming: false,
          createdAt: timestamp,
        };
        return {
          chatMessages: { ...state.chatMessages, [nodeId]: next },
        };
      }

      const thinkingStreamIndex = messages.findIndex((msg) => msg.id === thinkingStreamId);
      if (thinkingStreamIndex >= 0) {
        const existing = messages[thinkingStreamIndex];
        if (!existing) return state;
        const next = [...messages];
        next[thinkingStreamIndex] = {
          ...existing,
          thinking: content,
          thinkingStreaming: false,
          createdAt: timestamp,
        };
        return {
          chatMessages: { ...state.chatMessages, [nodeId]: next },
        };
      }

      const nextMessage: ChatMessage = {
        id: thinkingStreamId,
        nodeId,
        role: 'assistant',
        content: '',
        createdAt: timestamp,
        streaming: true,
        thinking: content,
        thinkingStreaming: false,
      };
      return {
        chatMessages: {
          ...state.chatMessages,
          [nodeId]: [...messages, nextMessage],
        },
      };
    }),

  clearNodeMessages: (nodeId) =>
    set((state) => {
      if (!state.chatMessages[nodeId]) {
        return state;
      }
      const { [nodeId]: _removed, ...remaining } = state.chatMessages;
      return { chatMessages: remaining };
    }),

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
