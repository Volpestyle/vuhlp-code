import { useState, useCallback, useEffect, useRef } from 'react';
import { Size, DEFAULT_WINDOW_SIZE } from './coordinateUtils';

/**
 * State for a single node window.
 */
export interface WindowState {
  size: Size;
}

/**
 * Saved window states per run.
 */
interface SavedWindowStates {
  sizes: Record<string, Size>;
}

const STORAGE_PREFIX = 'vuhlp-graph-window-sizes-';

function getStorageKey(runId: string): string {
  return `${STORAGE_PREFIX}${runId}`;
}

function loadSavedStates(runId: string): SavedWindowStates | null {
  try {
    const stored = localStorage.getItem(getStorageKey(runId));
    if (stored) {
      return JSON.parse(stored) as SavedWindowStates;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function saveStates(runId: string, states: SavedWindowStates): void {
  try {
    localStorage.setItem(getStorageKey(runId), JSON.stringify(states));
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

export function clearSavedWindowStates(runId: string): void {
  try {
    localStorage.removeItem(getStorageKey(runId));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Hook to manage window sizes for node windows.
 * Positions are managed by Cytoscape, sizes are managed here.
 */
export function useNodeWindowState(runId: string | null) {
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const runIdRef = useRef(runId);

  // Load saved sizes when run changes
  useEffect(() => {
    if (runId !== runIdRef.current) {
      runIdRef.current = runId;
      if (runId) {
        const saved = loadSavedStates(runId);
        if (saved?.sizes) {
          setSizes(saved.sizes);
        } else {
          setSizes({});
        }
      } else {
        setSizes({});
      }
    }
  }, [runId]);

  // Save sizes when they change
  useEffect(() => {
    if (runId && Object.keys(sizes).length > 0) {
      saveStates(runId, { sizes });
    }
  }, [runId, sizes]);

  const getWindowSize = useCallback(
    (nodeId: string): Size => {
      return sizes[nodeId] || DEFAULT_WINDOW_SIZE;
    },
    [sizes]
  );

  const updateWindowSize = useCallback(
    (nodeId: string, size: Size) => {
      setSizes((prev) => ({
        ...prev,
        [nodeId]: size,
      }));
    },
    []
  );

  const resetWindowSizes = useCallback(() => {
    setSizes({});
    if (runId) {
      clearSavedWindowStates(runId);
    }
  }, [runId]);

  return {
    getWindowSize,
    updateWindowSize,
    resetWindowSizes,
  };
}
