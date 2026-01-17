import { useMemo } from 'react';
import { useGraphStore } from '../../stores/graph-store';
import { useRunStore } from '../../stores/runStore';
import { getFocusZoomLevels, type ViewportSize } from '../../lib/graphFocus';
import { FullscreenChat } from '../FullscreenChat';
import './NodeFocusOverlay.css';

type FocusPhase = 'mid' | 'full';

interface NodeFocusOverlayProps {
  viewportSize: ViewportSize;
}

export function NodeFocusOverlay({ viewportSize }: NodeFocusOverlayProps) {
  const viewMode = useRunStore((s) => s.ui.viewMode);
  const selectedNodeId = useRunStore((s) => s.ui.selectedNodeId);
  const node = useGraphStore((s) =>
    selectedNodeId ? s.nodes.find((item) => item.id === selectedNodeId) : null
  );
  const viewport = useGraphStore((s) => s.viewport);

  if (!viewportSize.width || !viewportSize.height) {
    return null;
  }

  const focusPhase = useMemo<FocusPhase | null>(() => {
    if (!node || viewMode !== 'fullscreen') return null;
    const { fullZoom, midZoom } = getFocusZoomLevels(node, viewportSize);
    if (viewport.zoom >= fullZoom * 0.92) return 'full';
    if (viewport.zoom >= midZoom) return 'mid';
    return null;
  }, [node, viewMode, viewport.zoom, viewportSize]);

  if (!node || !focusPhase) {
    return null;
  }

  const width = node.dimensions.width * viewport.zoom;
  const height = node.dimensions.height * viewport.zoom;
  const left = node.position.x * viewport.zoom + viewport.x;
  const top = node.position.y * viewport.zoom + viewport.y;

  return (
    <div className="node-focus-overlay">
      <div
        className={`node-focus-overlay__window node-focus-overlay__window--${focusPhase}`}
        style={{ width, height, transform: `translate(${left}px, ${top}px)` }}
        data-graph-zoom-block
      >
        <FullscreenChat node={node} variant={focusPhase} interactive={focusPhase === 'full'} />
      </div>
    </div>
  );
}
