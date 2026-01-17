/**
 * Zustand store for run state management
 * Handles nodes, edges, artifacts, and UI state
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  RunState,
  NodeState,
  EdgeState,
  Artifact,
  OrchestrationMode,
  GlobalMode,
  RunStatus,
  ApprovalRequest,
  Envelope,
  ToolCall,
  UUID,
  ISO8601,
} from '@vuhlp/contracts';
import { getInitialTheme, type ThemeMode } from '../lib/theme';

export type ViewMode = 'graph' | 'fullscreen' | 'collapsed';

/** Tool event for tracking tool usage per node */
export interface ToolEvent {
  id: UUID;
  nodeId: UUID;
  tool: ToolCall;
  status: 'proposed' | 'started' | 'completed' | 'failed';
  timestamp: ISO8601;
  result?: { ok: boolean };
  error?: { message: string };
}

export interface ChatMessage {
  id: string;
  nodeId: UUID;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: ISO8601;
  streaming?: boolean;
}

/** Stall evidence from run.stalled event */
export interface StallEvidence {
  outputHash?: string;
  diffHash?: string;
  verificationFailure?: string;
  summaries: string[];
}

interface UIState {
  viewMode: ViewMode;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  inspectorOpen: boolean;
  sidebarOpen: boolean;
  theme: ThemeMode;
}

/** Stall state for UI notification */
interface StallState {
  isStalled: boolean;
  evidence: StallEvidence | null;
  timestamp: ISO8601 | null;
}

interface RunStore {
  // Run state
  run: RunState | null;
  pendingApprovals: ApprovalRequest[];
  recentHandoffs: Envelope[];
  chatMessages: Record<UUID, ChatMessage[]>;
  toolEvents: ToolEvent[];
  stall: StallState;

  // UI state
  ui: UIState;

  // Actions - Run
  setRun: (run: RunState) => void;
  applyRunPatch: (patch: Partial<RunState>) => void;
  updateRunStatus: (status: RunStatus) => void;
  setOrchestrationMode: (mode: OrchestrationMode) => void;
  setGlobalMode: (mode: GlobalMode) => void;

  // Actions - Nodes
  addNode: (node: NodeState) => void;
  updateNode: (nodeId: string, patch: Partial<NodeState>) => void;
  removeNode: (nodeId: string) => void;
  duplicateNode: (nodeId: string) => void;
  toggleNodeRunning: (nodeId: string) => void;

  // Actions - Edges
  addEdge: (edge: EdgeState) => void;
  removeEdge: (edgeId: string) => void;
  updateEdgeLabel: (edgeId: string, label: string) => void;

  // Actions - Artifacts
  addArtifact: (artifact: Artifact) => void;

  // Actions - Approvals
  addApproval: (approval: ApprovalRequest) => void;
  removeApproval: (approvalId: string) => void;

  // Actions - Handoffs
  addHandoff: (envelope: Envelope) => void;

  // Actions - Chat
  addChatMessage: (message: ChatMessage) => void;
  appendAssistantDelta: (nodeId: string, delta: string, timestamp: ISO8601) => void;
  finalizeAssistantMessage: (nodeId: string, content: string, timestamp: ISO8601) => void;

  // Actions - Tool Events
  addToolEvent: (event: ToolEvent) => void;
  updateToolEvent: (toolId: string, update: Partial<ToolEvent>) => void;

  // Actions - Stall
  setStall: (evidence: StallEvidence) => void;
  clearStall: () => void;

  // Actions - UI
  setViewMode: (mode: ViewMode) => void;
  selectNode: (nodeId: string | null) => void;
  selectEdge: (edgeId: string | null) => void;
  toggleInspector: () => void;
  toggleSidebar: () => void;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;

  // Computed
  getNode: (nodeId: string) => NodeState | undefined;
  getNodeEdges: (nodeId: string) => EdgeState[];
  getNodeArtifacts: (nodeId: string) => Artifact[];
  getNodeToolEvents: (nodeId: string) => ToolEvent[];
  getNodeMessages: (nodeId: string) => ChatMessage[];
}

const initialUIState: UIState = {
  viewMode: 'graph',
  selectedNodeId: null,
  selectedEdgeId: null,
  inspectorOpen: true,
  sidebarOpen: true,
  theme: getInitialTheme(),
};

const initialStallState: StallState = {
  isStalled: false,
  evidence: null,
  timestamp: null,
};

const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];

export const useRunStore = create<RunStore>()(
  subscribeWithSelector((set, get) => ({
    run: null,
    pendingApprovals: [],
    recentHandoffs: [],
    chatMessages: {},
    toolEvents: [],
    stall: initialStallState,
    ui: initialUIState,

    // Run actions
    setRun: (run) => set({ run }),
    applyRunPatch: (patch) =>
      set((state) => {
        if (!state.run) {
          if (!patch.id) {
            return state;
          }
          return { run: patch as RunState };
        }
        return {
          run: {
            ...state.run,
            ...patch,
            nodes: patch.nodes ? { ...state.run.nodes, ...patch.nodes } : state.run.nodes,
            edges: patch.edges ? { ...state.run.edges, ...patch.edges } : state.run.edges,
            artifacts: patch.artifacts ? { ...state.run.artifacts, ...patch.artifacts } : state.run.artifacts,
            updatedAt: patch.updatedAt ?? state.run.updatedAt,
          },
        };
      }),

    updateRunStatus: (status) =>
      set((state) => ({
        run: state.run ? { ...state.run, status, updatedAt: new Date().toISOString() } : null,
      })),


    setOrchestrationMode: (mode) =>
      set((state) => ({
        run: state.run ? { ...state.run, mode, updatedAt: new Date().toISOString() } : null,
      })),

    setGlobalMode: (globalMode) =>
      set((state) => ({
        run: state.run ? { ...state.run, globalMode, updatedAt: new Date().toISOString() } : null,
      })),

    // Node actions
    addNode: (node) =>
      set((state) => ({
        run: state.run
          ? {
              ...state.run,
              nodes: { ...state.run.nodes, [node.id]: node },
              updatedAt: new Date().toISOString(),
            }
          : null,
      })),

    updateNode: (nodeId, patch) =>
      set((state) => {
        if (!state.run?.nodes[nodeId]) return state;
        const existingNode = state.run.nodes[nodeId];
        return {
          run: {
            ...state.run,
            nodes: {
              ...state.run.nodes,
              [nodeId]: { ...existingNode, ...patch },
            },
            updatedAt: new Date().toISOString(),
          },
        };
      }),

    removeNode: (nodeId) =>
      set((state) => {
        if (!state.run) return state;
        const { [nodeId]: _removed, ...remainingNodes } = state.run.nodes;
        // Also remove edges connected to this node
        const remainingEdgesEntries = Object.entries(state.run.edges).filter(
          ([, edge]) => edge.from !== nodeId && edge.to !== nodeId
        );
        const remainingEdges = Object.fromEntries(remainingEdgesEntries);
        const selectedEdgeId = state.ui.selectedEdgeId;
        const selectedEdge = selectedEdgeId ? state.run.edges[selectedEdgeId] : null;
        const shouldClearEdgeSelection =
          selectedEdgeId &&
          (!selectedEdge || selectedEdge.from === nodeId || selectedEdge.to === nodeId);
        const shouldClearNodeSelection = state.ui.selectedNodeId === nodeId;
        let nextUi = state.ui;
        if (shouldClearNodeSelection || shouldClearEdgeSelection) {
          nextUi = {
            ...state.ui,
            selectedNodeId: shouldClearNodeSelection ? null : state.ui.selectedNodeId,
            selectedEdgeId: shouldClearEdgeSelection ? null : state.ui.selectedEdgeId,
          };
        }
        const { [nodeId]: _messages, ...remainingMessages } = state.chatMessages;
        return {
          run: {
            ...state.run,
            nodes: remainingNodes,
            edges: remainingEdges,
            updatedAt: new Date().toISOString(),
          },
          chatMessages: remainingMessages,
          ui: nextUi,
        };
      }),

    duplicateNode: (nodeId) =>
      set((state) => {
        if (!state.run?.nodes[nodeId]) return state;
        const sourceNode = state.run.nodes[nodeId];
        const newId = crypto.randomUUID();
        const newNode: NodeState = {
          ...sourceNode,
          id: newId,
          label: `${sourceNode.label} (copy)`,
          status: 'idle',
          summary: 'Duplicated node',
          lastActivityAt: new Date().toISOString(),
          connection: { status: 'disconnected', streaming: false, lastHeartbeatAt: new Date().toISOString(), lastOutputAt: new Date().toISOString() },
          inboxCount: 0,
        };
        console.log('[store] duplicateNode:', { sourceId: nodeId, newId });
        return {
          run: {
            ...state.run,
            nodes: { ...state.run.nodes, [newId]: newNode },
            updatedAt: new Date().toISOString(),
          },
          ui: { ...state.ui, selectedNodeId: newId, selectedEdgeId: null },
        };
      }),

    toggleNodeRunning: (nodeId) =>
      set((state) => {
        if (!state.run?.nodes[nodeId]) return state;
        const node = state.run.nodes[nodeId];
        const newStatus = node.status === 'running' ? 'idle' : 'running';
        console.log('[store] toggleNodeRunning:', { nodeId, from: node.status, to: newStatus });
        return {
          run: {
            ...state.run,
            nodes: {
              ...state.run.nodes,
              [nodeId]: { ...node, status: newStatus, lastActivityAt: new Date().toISOString() },
            },
            updatedAt: new Date().toISOString(),
          },
        };
      }),

    // Edge actions
    addEdge: (edge) =>
      set((state) => {
        const normalizedEdge = {
          ...edge,
          bidirectional: edge.bidirectional ?? true,
        };
        return {
          run: state.run
            ? {
                ...state.run,
                edges: { ...state.run.edges, [edge.id]: normalizedEdge },
                updatedAt: new Date().toISOString(),
              }
            : null,
        };
      }),

    removeEdge: (edgeId) =>
      set((state) => {
        if (!state.run) return state;
        const { [edgeId]: _removed, ...remainingEdges } = state.run.edges;
        return {
          run: {
            ...state.run,
            edges: remainingEdges,
            updatedAt: new Date().toISOString(),
          },
          ui:
            state.ui.selectedEdgeId === edgeId
              ? { ...state.ui, selectedEdgeId: null }
              : state.ui,
        };
      }),

    updateEdgeLabel: (edgeId, label) =>
      set((state) => {
        if (!state.run?.edges[edgeId]) return state;
        return {
          run: {
            ...state.run,
            edges: {
              ...state.run.edges,
              [edgeId]: { ...state.run.edges[edgeId], label },
            },
            updatedAt: new Date().toISOString(),
          },
        };
      }),

    // Artifact actions
    addArtifact: (artifact) =>
      set((state) => ({
        run: state.run
          ? {
              ...state.run,
              artifacts: { ...state.run.artifacts, [artifact.id]: artifact },
              updatedAt: new Date().toISOString(),
            }
          : null,
      })),

    // Approval actions
    addApproval: (approval) =>
      set((state) => ({
        pendingApprovals: [...state.pendingApprovals, approval],
      })),

    removeApproval: (approvalId) =>
      set((state) => ({
        pendingApprovals: state.pendingApprovals.filter((a) => a.approvalId !== approvalId),
      })),

    // Handoff actions
    addHandoff: (envelope) =>
      set((state) => ({
        recentHandoffs: [envelope, ...state.recentHandoffs].slice(0, 50),
      })),

    // Chat actions
    addChatMessage: (message) =>
      set((state) => {
        const nodeId = message.nodeId;
        const messages = state.chatMessages[nodeId] ?? [];
        const isLocal = message.id.startsWith('local-');
        if (!isLocal) {
          const matchIndex = messages.findIndex((existing) => {
            if (!existing.id.startsWith('local-')) return false;
            if (existing.role !== message.role) return false;
            if (existing.content !== message.content) return false;
            const existingTime = Date.parse(existing.createdAt);
            const messageTime = Date.parse(message.createdAt);
            if (Number.isNaN(existingTime) || Number.isNaN(messageTime)) return false;
            return Math.abs(existingTime - messageTime) < 5000;
          });
          if (matchIndex >= 0) {
            const next = [...messages];
            next[matchIndex] = { ...message };
            return {
              chatMessages: {
                ...state.chatMessages,
                [nodeId]: next,
              },
            };
          }
        }
        return {
          chatMessages: {
            ...state.chatMessages,
            [nodeId]: [...messages, message],
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
          const next = [...messages];
          next[existingIndex] = {
            ...existing,
            content: `${existing.content}${delta}`,
            createdAt: timestamp,
            streaming: true,
          };
          return {
            chatMessages: { ...state.chatMessages, [nodeId]: next },
          };
        }
        const nextMessage: ChatMessage = {
          id: streamId,
          nodeId,
          role: 'assistant',
          content: delta,
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

    finalizeAssistantMessage: (nodeId, content, timestamp) =>
      set((state) => {
        const messages = state.chatMessages[nodeId] ?? [];
        const streamId = `stream-${nodeId}`;
        const filtered = messages.filter((msg) => msg.id !== streamId);
        const nextMessage: ChatMessage = {
          id: crypto.randomUUID(),
          nodeId,
          role: 'assistant',
          content,
          createdAt: timestamp,
        };
        return {
          chatMessages: {
            ...state.chatMessages,
            [nodeId]: [...filtered, nextMessage],
          },
        };
      }),

    // Tool Events
    addToolEvent: (event) =>
      set((state) => ({
        toolEvents: [...state.toolEvents, event].slice(-100), // Keep last 100
      })),

    updateToolEvent: (toolId, update) =>
      set((state) => ({
        toolEvents: state.toolEvents.map((e) =>
          e.tool.id === toolId ? { ...e, ...update } : e
        ),
      })),

    // Stall actions
    setStall: (evidence) =>
      set(() => ({
        stall: { isStalled: true, evidence, timestamp: new Date().toISOString() },
      })),

    clearStall: () =>
      set(() => ({
        stall: initialStallState,
      })),

    // UI actions
    setViewMode: (viewMode) =>
      set((state) => ({ ui: { ...state.ui, viewMode } })),

    selectNode: (selectedNodeId) =>
      set((state) => ({ ui: { ...state.ui, selectedNodeId, selectedEdgeId: null } })),

    selectEdge: (selectedEdgeId) =>
      set((state) => ({ ui: { ...state.ui, selectedEdgeId, selectedNodeId: null } })),

    toggleInspector: () =>
      set((state) => ({
        ui: { ...state.ui, inspectorOpen: !state.ui.inspectorOpen },
      })),

    toggleSidebar: () =>
      set((state) => ({
        ui: { ...state.ui, sidebarOpen: !state.ui.sidebarOpen },
      })),

    setTheme: (theme) =>
      set((state) => ({
        ui: { ...state.ui, theme },
      })),

    toggleTheme: () =>
      set((state) => ({
        ui: { ...state.ui, theme: state.ui.theme === 'dark' ? 'light' : 'dark' },
      })),

    // Computed
    getNode: (nodeId) => get().run?.nodes[nodeId],

    getNodeEdges: (nodeId) => {
      const edges = get().run?.edges ?? {};
      return Object.values(edges).filter(
        (edge) => edge.from === nodeId || edge.to === nodeId
      );
    },

    getNodeArtifacts: (nodeId) => {
      const artifacts = get().run?.artifacts ?? {};
      return Object.values(artifacts).filter((a) => a.nodeId === nodeId);
    },

    getNodeToolEvents: (nodeId) =>
      get().toolEvents.filter((e) => e.nodeId === nodeId),

    getNodeMessages: (nodeId) => get().chatMessages[nodeId] ?? EMPTY_CHAT_MESSAGES,
  }))
);

// Selectors for common operations
export const selectNodes = (state: RunStore) =>
  state.run ? Object.values(state.run.nodes) : [];

export const selectEdges = (state: RunStore) =>
  state.run ? Object.values(state.run.edges) : [];

export const selectSelectedNode = (state: RunStore) =>
  state.ui.selectedNodeId && state.run
    ? state.run.nodes[state.ui.selectedNodeId]
    : null;

export const selectSelectedEdge = (state: RunStore) =>
  state.ui.selectedEdgeId && state.run
    ? state.run.edges[state.ui.selectedEdgeId]
    : null;
