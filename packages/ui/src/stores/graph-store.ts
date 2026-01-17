import { create } from 'zustand';
import type { RunState } from '@vuhlp/contracts';
import { VisualNode, VisualEdge } from '../types/graph';

/** Layout data that persists per run */
interface LayoutData {
  positions: Record<string, { x: number; y: number }>;
  viewport: { x: number; y: number; zoom: number };
}

interface GraphState {
  nodes: VisualNode[];
  edges: VisualEdge[];
  viewport: { x: number; y: number; zoom: number };
  currentRunId: string | null;
  layoutPositions: Record<string, { x: number; y: number }> | null;

  // Actions
  setNodes: (nodes: VisualNode[]) => void;
  updateNodePosition: (id: string, x: number, y: number) => void;
  addEdge: (edge: VisualEdge) => void;
  setEdges: (edges: VisualEdge[]) => void;
  setViewport: (viewport: { x: number; y: number; zoom: number }, persist?: boolean) => void;
  setCurrentRunId: (runId: string) => void;
  loadLayoutForRun: (runId: string) => void;
  saveLayoutForRun: () => void;
  syncWithRun: (
    run: RunState | null,
    selectedNodeId: string | null,
    selectedEdgeId: string | null
  ) => void;
}

const DEFAULT_NODE_DIMENSIONS = { width: 240, height: 160 };
const DEFAULT_ORIGIN = { x: 200, y: 150 };
const DEFAULT_SPACING = { x: 280, y: 200 };

function defaultPosition(index: number): { x: number; y: number } {
  const col = index % 4;
  const row = Math.floor(index / 4);
  return {
    x: DEFAULT_ORIGIN.x + col * DEFAULT_SPACING.x,
    y: DEFAULT_ORIGIN.y + row * DEFAULT_SPACING.y
  };
}

/** Storage key prefix for layout persistence */
const LAYOUT_STORAGE_KEY = 'vuhlp-graph-layout';

/** Get layout storage key for a specific run */
function getLayoutKey(runId: string): string {
  return `${LAYOUT_STORAGE_KEY}-${runId}`;
}

/** Load layout data from localStorage */
function loadLayout(runId: string): LayoutData | null {
  try {
    const data = localStorage.getItem(getLayoutKey(runId));
    if (data) {
      const parsed = JSON.parse(data) as LayoutData;
      console.log('[graph-store] loaded layout for run:', runId, parsed);
      return parsed;
    }
  } catch (err) {
    console.error('[graph-store] failed to load layout:', err);
  }
  return null;
}

/** Save layout data to localStorage */
function saveLayout(runId: string, layout: LayoutData): void {
  try {
    localStorage.setItem(getLayoutKey(runId), JSON.stringify(layout));
    console.log('[graph-store] saved layout for run:', runId);
  } catch (err) {
    console.error('[graph-store] failed to save layout:', err);
  }
}

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  currentRunId: null,
  layoutPositions: null,

  setNodes: (nodes) => set({ nodes }),

  addEdge: (edge) =>
    set((state) => ({
      edges: [...state.edges, edge],
    })),

  updateNodePosition: (id, x, y) => {
    set((state) => {
      const nodes = state.nodes.map(node =>
        node.id === id ? { ...node, position: { x, y } } : node
      );
      const layoutPositions = {
        ...(state.layoutPositions ?? {}),
        [id]: { x, y }
      };
      return { nodes, layoutPositions };
    });
    // Auto-save layout after position update (debounced in real usage)
    const state = get();
    if (state.currentRunId) {
      const positions: Record<string, { x: number; y: number }> = {};
      state.nodes.forEach(node => {
        positions[node.id] = node.position;
      });
      saveLayout(state.currentRunId, { positions, viewport: state.viewport });
    }
  },

  setEdges: (edges) => set({ edges }),

  setViewport: (viewport, persist = true) => {
    set({ viewport });
    if (!persist) return;
    // Auto-save layout after viewport change
    const state = get();
    if (state.currentRunId) {
      const positions: Record<string, { x: number; y: number }> = {};
      state.nodes.forEach(node => {
        positions[node.id] = node.position;
      });
      saveLayout(state.currentRunId, { positions, viewport });
    }
  },

  setCurrentRunId: (runId) => set({ currentRunId: runId }),

  loadLayoutForRun: (runId) => {
    const layout = loadLayout(runId);
    if (layout) {
      set((state) => ({
        currentRunId: runId,
        viewport: layout.viewport,
        layoutPositions: layout.positions,
        nodes: state.nodes.map(node => {
          const savedPosition = layout.positions[node.id];
          if (savedPosition) {
            return { ...node, position: savedPosition };
          }
          return node;
        }),
      }));
    } else {
      set({ currentRunId: runId, layoutPositions: null });
    }
  },

  saveLayoutForRun: () => {
    const state = get();
    if (!state.currentRunId) {
      console.warn('[graph-store] cannot save layout - no run ID set');
      return;
    }
    const positions: Record<string, { x: number; y: number }> = {};
    state.nodes.forEach(node => {
      positions[node.id] = node.position;
    });
    saveLayout(state.currentRunId, { positions, viewport: state.viewport });
    set({ layoutPositions: positions });
  },

  syncWithRun: (run, selectedNodeId, selectedEdgeId) => {
    if (!run) {
      return;
    }
    set((state) => {
      const existingNodes = new Map(state.nodes.map((node) => [node.id, node]));
      const layoutPositions = state.layoutPositions ?? {};
      const runNodes = Object.values(run.nodes);
      const nodes = runNodes.map((node, index) => {
        const existing = existingNodes.get(node.id);
        const position = existing?.position ?? layoutPositions[node.id] ?? defaultPosition(index);
        const dimensions = existing?.dimensions ?? DEFAULT_NODE_DIMENSIONS;
        return {
          ...node,
          position,
          dimensions,
          selected: node.id === selectedNodeId
        };
      });
      const edges = Object.values(run.edges).map((edge) => ({
        ...edge,
        selected: edge.id === selectedEdgeId
      }));
      return {
        nodes,
        edges,
        currentRunId: run.id
      };
    });
  },
}));
