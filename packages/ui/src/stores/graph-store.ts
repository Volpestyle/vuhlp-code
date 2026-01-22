import { create } from 'zustand';
import type { GraphLayout, RunState } from '@vuhlp/contracts';
import { VisualNode, VisualEdge } from '../types/graph';

interface GraphState {
  nodes: VisualNode[];
  edges: VisualEdge[];
  viewport: { x: number; y: number; zoom: number };
  currentRunId: string | null;
  layoutUpdatedAt: string | null;
  layoutDirty: boolean;

  updateNodePosition: (id: string, x: number, y: number) => void;
  addEdge: (edge: VisualEdge) => void;
  setViewport: (viewport: { x: number; y: number; zoom: number }, persist?: boolean) => void;
  syncWithRun: (
    run: RunState | null,
    selectedNodeId: string | null,
    selectedEdgeId: string | null
  ) => void;
}

const DEFAULT_NODE_DIMENSIONS = { width: 240, height: 160 };
const DEFAULT_ORIGIN = { x: 200, y: 150 };
const DEFAULT_SPACING = { x: 280, y: 200 };
const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };

function defaultPosition(index: number): { x: number; y: number } {
  const col = index % 4;
  const row = Math.floor(index / 4);
  return {
    x: DEFAULT_ORIGIN.x + col * DEFAULT_SPACING.x,
    y: DEFAULT_ORIGIN.y + row * DEFAULT_SPACING.y
  };
}

function isLayoutNewer(layout: GraphLayout, currentUpdatedAt: string | null): boolean {
  if (!currentUpdatedAt) return true;
  const incomingTime = Date.parse(layout.updatedAt);
  const currentTime = Date.parse(currentUpdatedAt);
  if (Number.isNaN(incomingTime) || Number.isNaN(currentTime)) {
    console.warn('[graph-store] invalid layout timestamp comparison', {
      incoming: layout.updatedAt,
      current: currentUpdatedAt
    });
    return true;
  }
  return incomingTime >= currentTime;
}

function layoutMatchesState(
  layout: GraphLayout,
  nodes: VisualNode[],
  viewport: { x: number; y: number; zoom: number }
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

export const useGraphStore = create<GraphState>((set) => ({
  nodes: [],
  edges: [],
  viewport: DEFAULT_VIEWPORT,
  currentRunId: null,
  layoutUpdatedAt: null,
  layoutDirty: false,

  updateNodePosition: (id, x, y) => {
    const now = new Date().toISOString();
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === id ? { ...node, position: { x, y } } : node
      ),
      layoutUpdatedAt: now,
      layoutDirty: true
    }));
  },

  addEdge: (edge) =>
    set((state) => ({
      edges: [...state.edges, edge]
    })),

  setViewport: (viewport, persist = true) => {
    if (!persist) {
      set({ viewport });
      return;
    }
    const now = new Date().toISOString();
    set({
      viewport,
      layoutUpdatedAt: now,
      layoutDirty: true
    });
  },

  syncWithRun: (run, selectedNodeId, selectedEdgeId) => {
    if (!run) {
      return;
    }
    set((state) => {
      const runChanged = state.currentRunId !== run.id;
      const existingNodes = runChanged
        ? new Map()
        : new Map(state.nodes.map((node) => [node.id, node]));
      const incomingLayout = run.layout ?? null;
      const layoutMatchesLocal = incomingLayout
        ? layoutMatchesState(incomingLayout, state.nodes, state.viewport)
        : false;
      const shouldApplyLayout = incomingLayout
        ? runChanged ||
          (!state.layoutDirty && isLayoutNewer(incomingLayout, state.layoutUpdatedAt)) ||
          (state.layoutDirty && layoutMatchesLocal)
        : false;
      const runNodes = Object.values(run.nodes);
      const layoutPositions = incomingLayout?.positions ?? {};
      const missingPositions = runNodes.some((node) => !layoutPositions[node.id]);
      const markDirty = missingPositions && !state.layoutDirty;
      const nodes = runNodes.map((node, index) => {
        const existing = existingNodes.get(node.id);
        const layoutPosition = incomingLayout?.positions[node.id];
        const position = shouldApplyLayout
          ? layoutPosition ?? existing?.position ?? defaultPosition(index)
          : existing?.position ?? layoutPosition ?? defaultPosition(index);
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
      const nextViewport = shouldApplyLayout
        ? incomingLayout?.viewport ?? state.viewport
        : (runChanged ? DEFAULT_VIEWPORT : state.viewport);
      return {
        nodes,
        edges,
        viewport: nextViewport,
        currentRunId: run.id,
        layoutUpdatedAt: markDirty
          ? new Date().toISOString()
          : (shouldApplyLayout
            ? incomingLayout?.updatedAt ?? state.layoutUpdatedAt
            : (runChanged ? null : state.layoutUpdatedAt)),
        layoutDirty: markDirty ? true : (shouldApplyLayout ? false : (runChanged ? false : state.layoutDirty))
      };
    });
  }
}));
