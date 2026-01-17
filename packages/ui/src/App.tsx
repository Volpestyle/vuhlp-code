import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useRunStore, selectSelectedNode, selectSelectedEdge } from './stores/runStore';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useLayoutPersistence } from './hooks/useLayoutPersistence';
import { useWebSocket } from './hooks/useWebSocket';
import { useRunBootstrap } from './hooks/useRunBootstrap';
import { useGraphSync } from './hooks/useGraphSync';
import { useTheme } from './hooks/useTheme';
import { Header } from './components/Header';
import { GraphCanvas } from './components/graph/GraphCanvas';
import { NodeInspector } from './components/NodeInspector';
import { EdgeInspector } from './components/EdgeInspector';
import { ApprovalQueue } from './components/ApprovalQueue';
import { StallNotification } from './components/StallNotification';
import { NewNodeModal } from './components/NewNodeModal';
import { SessionPanel } from './components/SessionPanel';
import './styles/app.css';

const INSPECTOR_WIDTH_STORAGE_KEY = 'vuhlp-inspector-width';
const DEFAULT_INSPECTOR_WIDTH = 380;
const MIN_INSPECTOR_WIDTH = 280;
const MIN_CANVAS_WIDTH = 320;
const DEFAULT_SESSIONS_WIDTH = 280;

const clampInspectorWidth = (value: number, containerWidth: number, sessionsWidth: number) => {
  const maxWidth = Math.max(
    MIN_INSPECTOR_WIDTH,
    containerWidth - MIN_CANVAS_WIDTH - sessionsWidth
  );
  return Math.min(Math.max(value, MIN_INSPECTOR_WIDTH), maxWidth);
};

export function App() {
  const viewMode = useRunStore((s) => s.ui.viewMode);
  const inspectorOpen = useRunStore((s) => s.ui.inspectorOpen);
  const sidebarOpen = useRunStore((s) => s.ui.sidebarOpen);
  const selectedNode = useRunStore(selectSelectedNode);
  const selectedEdge = useRunStore(selectSelectedEdge);
  const pendingApprovals = useRunStore((s) => s.pendingApprovals);
  const runId = useRunStore((s) => s.run?.id ?? null);
  const [newNodeOpen, setNewNodeOpen] = useState(false);
  const sessionsWidth = viewMode === 'fullscreen' ? 0 : (sidebarOpen ? DEFAULT_SESSIONS_WIDTH : 40);
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_INSPECTOR_WIDTH;
    const stored = window.localStorage.getItem(INSPECTOR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number(stored) : Number.NaN;
    const initial = Number.isFinite(parsed) ? parsed : DEFAULT_INSPECTOR_WIDTH;
    return clampInspectorWidth(initial, window.innerWidth, sessionsWidth);
  });
  const appMainRef = useRef<HTMLElement | null>(null);

  // Register keyboard shortcuts
  useKeyboardShortcuts();

  // Enable layout persistence (saves/loads node positions per run)
  useLayoutPersistence();

  // Apply theme and persist preference
  useTheme();

  // Create a run if none exists and connect to event stream
  useRunBootstrap();
  useWebSocket(runId);

  // Sync runtime state into the graph view
  useGraphSync();

  const handleInspectorResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const main = appMainRef.current;
      if (!main) return;
      const bounds = main.getBoundingClientRect();
      const updateWidth = (clientX: number) => {
        const nextWidth = bounds.right - clientX;
        const clamped = clampInspectorWidth(nextWidth, bounds.width, sessionsWidth);
        setInspectorWidth(clamped);
      };

      document.body.classList.add('is-resizing');
      updateWidth(event.clientX);

      const handleMove = (moveEvent: PointerEvent) => {
        updateWidth(moveEvent.clientX);
      };

      const handleUp = () => {
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        window.removeEventListener('pointercancel', handleUp);
        document.body.classList.remove('is-resizing');
      };

      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
      window.addEventListener('pointercancel', handleUp);
    },
    [sessionsWidth]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        INSPECTOR_WIDTH_STORAGE_KEY,
        String(Math.round(inspectorWidth))
      );
    } catch {
      // Ignore storage errors (private mode or blocked storage).
    }
  }, [inspectorWidth]);

  useEffect(() => {
    const handleResize = () => {
      const main = appMainRef.current;
      const width = main?.getBoundingClientRect().width ?? window.innerWidth;
      setInspectorWidth((prev) => clampInspectorWidth(prev, width, sessionsWidth));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [sessionsWidth]);

  const handleOpenNewNode = useCallback(() => {
    setNewNodeOpen(true);
  }, []);

  // Default: Graph + Inspector mode
  return (
    <div
      className={`app app--${viewMode}`}
      style={{
        ['--inspector-width' as keyof CSSProperties]: `${inspectorWidth}px`,
        ['--sessions-width' as keyof CSSProperties]: `${sessionsWidth}px`,
      }}
    >
      <Header minimal={viewMode === 'fullscreen'} onOpenNewNode={handleOpenNewNode} />
      <main className="app__main" ref={appMainRef}>
        {viewMode !== 'fullscreen' && (
          <aside className={`app__sessions ${sidebarOpen ? '' : 'app__sessions--collapsed'}`}>
            <SessionPanel collapsed={!sidebarOpen} />
          </aside>
        )}
        <div className="app__canvas">
          {/* WebGL GraphCanvas - owned by Agent 4 */}
          <GraphCanvas />
        </div>
        {inspectorOpen && (selectedNode || selectedEdge) && viewMode === 'graph' && (
          <aside className="app__inspector">
            <div
              className="app__inspector-resizer"
              onPointerDown={handleInspectorResizeStart}
              title="Drag to resize"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize inspector"
            />
            {selectedNode ? (
              <NodeInspector node={selectedNode} />
            ) : selectedEdge ? (
              <EdgeInspector edge={selectedEdge} />
            ) : null}
          </aside>
        )}
      </main>
      {pendingApprovals.length > 0 && (
        <ApprovalQueue approvals={pendingApprovals} />
      )}
      <StallNotification />
      <NewNodeModal open={newNodeOpen} onClose={() => setNewNodeOpen(false)} />
    </div>
  );
}

// Re-export for compatibility with older imports
export { App as default };
