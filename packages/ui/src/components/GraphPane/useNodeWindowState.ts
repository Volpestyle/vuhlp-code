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

// Debounce delay for localStorage writes (ms)
const SAVE_DEBOUNCE_MS = 300;

/**
 * Hook to manage window sizes for node windows.
 * Positions are managed by Cytoscape, sizes are managed here.
 */
export function useNodeWindowState(runId: string | null) {
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const runIdRef = useRef(runId);
  const saveTimeoutRef = useRef<number | null>(null);

  // Load saved sizes when run changes
  useEffect(() => {
    if (runId !== runIdRef.current) {
      runIdRef.current = runId;
      // Clear any pending save when run changes
      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
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

  // Save sizes when they change (debounced to avoid excessive localStorage writes during resize)
  useEffect(() => {
    if (!runId || Object.keys(sizes).length === 0) return;

    // Clear any pending save
    if (saveTimeoutRef.current) {
      window.clearTimeout(saveTimeoutRef.current);
    }

    // Schedule debounced save
    saveTimeoutRef.current = window.setTimeout(() => {
      saveStates(runId, { sizes });
      saveTimeoutRef.current = null;
    }, SAVE_DEBOUNCE_MS);

    // Cleanup on unmount or dependency change
    return () => {
      if (saveTimeoutRef.current) {
        // Save immediately on cleanup to avoid losing changes
        saveStates(runId, { sizes });
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
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
