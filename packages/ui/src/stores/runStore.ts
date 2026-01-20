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
  TurnStatus,
  UUID,
  ISO8601,
} from '@vuhlp/contracts';
import { getInitialTheme, type ThemeMode } from '../lib/theme';
import { buildTimeline, stripToolCallLines, type TimelineItem } from '@vuhlp/shared';

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

export interface TurnStatusEvent {
  id: UUID;
  nodeId: UUID;
  status: TurnStatus;
  detail?: string;
  timestamp: ISO8601;
}

export interface NodeLogEntry {
  id: UUID;
  nodeId: UUID;
  source: 'stdout' | 'stderr';
  line: string;
  timestamp: ISO8601;
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
  rawContent?: string;
}

/** Stall evidence from run.stalled event */
export interface StallEvidence {
  outputHash?: string;
  diffHash?: string;
  verificationFailure?: string;
  summaries: string[];
}

export type WsConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface UIState {
  viewMode: ViewMode;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  inspectorOpen: boolean;
  sidebarOpen: boolean;
  theme: ThemeMode;
  wsConnectionStatus: WsConnectionStatus;
  wsLastError?: string;
  lastHandoffs: Record<string, { timestamp: number; fromNodeId: string; toNodeId: string }>;
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
  pendingEdges: Record<UUID, EdgeState>;
  pendingApprovals: ApprovalRequest[];
  recentHandoffs: Envelope[];
  chatMessages: Record<UUID, ChatMessage[]>;
  toolEvents: ToolEvent[];
  turnStatusEvents: TurnStatusEvent[];
  nodeLogs: Record<UUID, NodeLogEntry[]>;
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
  triggerHandoffAnimation: (edgeId: string, fromNodeId: string, toNodeId: string) => void;

  // Actions - Chat
  addChatMessage: (message: ChatMessage) => void;
  updateChatMessageStatus: (
    nodeId: string,
    messageId: string,
    updates: Partial<Pick<ChatMessage, 'pending' | 'sendError'>>
  ) => void;
  appendAssistantDelta: (nodeId: string, delta: string, timestamp: ISO8601) => void;
  finalizeAssistantMessage: (
    nodeId: string,
    content: string,
    timestamp: ISO8601,
    status?: ChatMessage['status'],
    id?: string
  ) => void;
  appendAssistantThinkingDelta: (nodeId: string, delta: string, timestamp: ISO8601) => void;
  finalizeAssistantThinking: (nodeId: string, content: string, timestamp: ISO8601) => void;
  clearNodeMessages: (nodeId: string) => void;
  finalizeNodeMessages: (nodeId: string, timestamp: ISO8601) => void;

  // Actions - Tool Events
  addToolEvent: (event: ToolEvent) => void;
  updateToolEvent: (toolId: string, update: Partial<ToolEvent>) => void;

  // Actions - Turn Status
  addTurnStatusEvent: (event: TurnStatusEvent) => void;

  // Actions - Node Logs
  addNodeLog: (entry: NodeLogEntry) => void;

  // Actions - Stall
  setStall: (evidence: StallEvidence) => void;
  clearStall: () => void;
  resetEventState: () => void;

  // Actions - UI
  setViewMode: (mode: ViewMode) => void;
  selectNode: (nodeId: string | null) => void;
  selectEdge: (edgeId: string | null) => void;
  toggleInspector: () => void;
  toggleSidebar: () => void;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setWsConnectionStatus: (status: WsConnectionStatus, error?: string) => void;

  // Computed
  getNode: (nodeId: string) => NodeState | undefined;
  getNodeEdges: (nodeId: string) => EdgeState[];
  getNodeArtifacts: (nodeId: string) => Artifact[];
  getNodeToolEvents: (nodeId: string) => ToolEvent[];
  getNodeTurnStatusEvents: (nodeId: string) => TurnStatusEvent[];
  getNodeMessages: (nodeId: string) => ChatMessage[];
  getNodeLogs: (nodeId: string) => NodeLogEntry[];
}

const initialStallState: StallState = {
  isStalled: false,
  evidence: null,
  timestamp: null,
};

const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];
const EMPTY_LOGS: NodeLogEntry[] = [];
const LOG_TAIL_LIMIT = 50;

const SIDEBAR_STORAGE_KEY = 'vuhlp-sidebar-open';

const getStoredSidebarOpen = (): boolean | null => {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch {
    return null;
  }
  return null;
};

const initialUIState: UIState = {
  viewMode: 'graph',
  selectedNodeId: null,
  selectedEdgeId: null,
  inspectorOpen: true,
  sidebarOpen: getStoredSidebarOpen() ?? true,
  theme: getInitialTheme(),
  wsConnectionStatus: 'disconnected',
  lastHandoffs: {},
};

export const useRunStore = create<RunStore>()(
  subscribeWithSelector((set, get) => ({
    run: null,
    pendingEdges: {},
    pendingApprovals: [],
    recentHandoffs: [],
    chatMessages: {},
    toolEvents: [],
    turnStatusEvents: [],
    nodeLogs: {},
    stall: initialStallState,
    ui: initialUIState,

    // Run actions
    setRun: (run) =>
      set((state) => {
        const pendingEdges = state.pendingEdges;
        const pendingCount = Object.keys(pendingEdges).length;
        if (pendingCount > 0) {
          console.info('[store] merging pending edges into run:', { count: pendingCount, runId: run.id });
        }
        return {
          run: pendingCount > 0 ? { ...run, edges: { ...pendingEdges, ...run.edges } } : run,
          pendingEdges: {},
        };
      }),
    applyRunPatch: (patch) =>
      set((state) => {
        if (!state.run) {
          if (!patch.id) {
            return state;
          }
          const pendingEdges = state.pendingEdges;
          const pendingCount = Object.keys(pendingEdges).length;
          if (pendingCount > 0) {
            console.info('[store] merging pending edges into run patch:', { count: pendingCount, runId: patch.id });
          }
          return {
            run: pendingCount > 0
              ? { ...(patch as RunState), edges: { ...pendingEdges, ...(patch.edges ?? {}) } }
              : (patch as RunState),
            pendingEdges: {},
          };
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
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
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
        if (!state.run) {
          console.warn('[store] queued edge before run loaded', { edgeId: edge.id });
          return {
            pendingEdges: { ...state.pendingEdges, [edge.id]: normalizedEdge },
          };
        }
        return {
          run: {
            ...state.run,
            edges: { ...state.run.edges, [edge.id]: normalizedEdge },
            updatedAt: new Date().toISOString(),
          },
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

    triggerHandoffAnimation: (edgeId, fromNodeId, toNodeId) =>
      set((state) => ({
        ui: {
          ...state.ui,
          lastHandoffs: {
            ...state.ui.lastHandoffs,
            [edgeId]: { timestamp: Date.now(), fromNodeId, toNodeId },
          },
        },
      })),

    // Chat actions
    addChatMessage: (message) =>
      set((state) => {
        const nodeId = message.nodeId;
        const messages = state.chatMessages[nodeId] ?? [];

        // Check for exact ID match first (update existing)
        const existingIdIndex = messages.findIndex((m) => m.id === message.id);
        if (existingIdIndex >= 0) {
          const next = [...messages];
          next[existingIdIndex] = { ...messages[existingIdIndex], ...message };
          return {
            chatMessages: {
              ...state.chatMessages,
              [nodeId]: next,
            },
          };
        }

        const isLocal = message.id.startsWith('local-');
        if (!isLocal) {
          // Try to match with a local optimistic message
          const matchIndex = messages.findIndex((existing) => {
            if (!existing.id.startsWith('local-')) return false;
            if (existing.role !== message.role) return false;
            if (existing.content.trim() !== message.content.trim()) return false;
            const existingTime = Date.parse(existing.createdAt);
            const messageTime = Date.parse(message.createdAt);
            if (Number.isNaN(existingTime) || Number.isNaN(messageTime)) return false;
            return Math.abs(existingTime - messageTime) < 10000;
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

    updateChatMessageStatus: (nodeId, messageId, updates) =>
      set((state) => {
        const messages = state.chatMessages[nodeId];
        if (!messages) return state;
        const index = messages.findIndex((m) => m.id === messageId);
        if (index < 0) return state;
        const next = [...messages];
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

        // Check if we already have this message (by ID)
        // This handles race conditions where the backend event is processed multiple times
        // or during history replay
        const hasExistingMessage = messages.some((msg) => msg.id === id);

        const filtered = messages.filter((msg) => msg.id !== streamId && msg.id !== thinkingStreamId);

        if (hasExistingMessage) {
          // If message exists, just remove stream and thinking
          return {
            chatMessages: {
              ...state.chatMessages,
              [nodeId]: filtered,
            },
          };
        }

        // Find the thinking content from the streaming message before we filter it out
        const streamingMsg = messages.find((msg) => msg.id === streamId);
        const thinkingStreamingMsg = messages.find((msg) => msg.id === thinkingStreamId);
        const thinking = streamingMsg?.thinking ?? thinkingStreamingMsg?.thinking;

        const nextMessage: ChatMessage = {
          id: id ?? `local-${crypto.randomUUID()}`,
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

        // If there's an existing stream message, append thinking to it
        if (existingStreamIndex >= 0) {
          const existing = messages[existingStreamIndex];
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

        // Otherwise create a new streaming message with thinking
        const thinkingStreamId = `thinking-stream-${nodeId}`;
        const existingThinkingIndex = messages.findIndex((msg) => msg.id === thinkingStreamId);

        if (existingThinkingIndex >= 0) {
          const existing = messages[existingThinkingIndex];
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

        // Try to find the stream message first
        const streamIndex = messages.findIndex((msg) => msg.id === streamId);
        if (streamIndex >= 0) {
          const existing = messages[streamIndex];
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

        // Try to find the thinking stream message
        const thinkingStreamIndex = messages.findIndex((msg) => msg.id === thinkingStreamId);
        if (thinkingStreamIndex >= 0) {
          const existing = messages[thinkingStreamIndex];
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

        // Create new message with just thinking
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

    finalizeNodeMessages: (nodeId, timestamp) =>
      set((state) => {
        const messages = state.chatMessages[nodeId];
        if (!messages) return state;

        const needsFinalization = messages.some(
          (m) => m.streaming || m.thinkingStreaming
        );
        if (!needsFinalization) return state;

        const next = messages.map((m) => {
          if (!m.streaming && !m.thinkingStreaming) return m;

          return {
            ...m,
            streaming: false,
            thinkingStreaming: false,
            status: m.status ?? 'interrupted',
            createdAt: timestamp,
          };
        });

        return {
          chatMessages: {
            ...state.chatMessages,
            [nodeId]: next,
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

    addTurnStatusEvent: (event) =>
      set((state) => ({
        turnStatusEvents: [...state.turnStatusEvents, event].slice(-200),
      })),

    addNodeLog: (entry) =>
      set((state) => {
        const existing = state.nodeLogs[entry.nodeId] ?? EMPTY_LOGS;
        const next = [...existing, entry].slice(-LOG_TAIL_LIMIT);
        return { nodeLogs: { ...state.nodeLogs, [entry.nodeId]: next } };
      }),

    // Stall actions
    setStall: (evidence) =>
      set(() => ({
        stall: { isStalled: true, evidence, timestamp: new Date().toISOString() },
      })),

    clearStall: () =>
      set(() => ({
        stall: initialStallState,
      })),

    resetEventState: () =>
      set(() => ({
        pendingEdges: {},
        pendingApprovals: [],
        recentHandoffs: [],
        chatMessages: {},
        toolEvents: [],
        turnStatusEvents: [],
        nodeLogs: {},
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
      set((state) => {
        const next = !state.ui.sidebarOpen;
        if (typeof window !== 'undefined') {
          try {
            window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
          } catch {
            // Ignore storage errors (private mode or blocked storage).
          }
        }
        return {
          ui: { ...state.ui, sidebarOpen: next },
        };
      }),

    setTheme: (theme) =>
      set((state) => ({
        ui: { ...state.ui, theme },
      })),

    toggleTheme: () =>
      set((state) => ({
        ui: { ...state.ui, theme: state.ui.theme === 'dark' ? 'light' : 'dark' },
      })),

    setWsConnectionStatus: (status, error) =>
      set((state) => ({
        ui: { ...state.ui, wsConnectionStatus: status, wsLastError: error },
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

    getNodeTurnStatusEvents: (nodeId) =>
      get().turnStatusEvents.filter((e) => e.nodeId === nodeId),

    getNodeMessages: (nodeId) => get().chatMessages[nodeId] ?? EMPTY_CHAT_MESSAGES,

    getNodeLogs: (nodeId) => get().nodeLogs[nodeId] ?? EMPTY_LOGS,
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

export type TimelineEvent = TimelineItem<ChatMessage, ToolEvent, TurnStatusEvent>;

export const selectNodeTimeline = (state: RunStore, nodeId: string): TimelineEvent[] => {
  const messages = state.chatMessages[nodeId] ?? EMPTY_CHAT_MESSAGES;
  const tools = state.toolEvents.filter((e) => e.nodeId === nodeId);
  const statuses = state.turnStatusEvents.filter((e) => e.nodeId === nodeId);

  return buildTimeline(messages, tools, statuses);
};
