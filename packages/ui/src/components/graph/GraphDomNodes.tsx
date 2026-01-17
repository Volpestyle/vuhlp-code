import { useMemo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ViewMode } from '../../stores/runStore';
import type { VisualNode } from '../../types/graph';
import { getFocusZoomLevels, type ViewportSize } from '../../lib/graphFocus';
import { NodeCard } from '../NodeCard';
import './GraphDomNodes.css';

interface GraphDomNodesProps {
  nodes: VisualNode[];
  viewport: { x: number; y: number; zoom: number };
  viewMode: ViewMode;
  selectedNodeId: string | null;
  viewportSize: ViewportSize;
  onNodePointerDown: (id: string, event: ReactPointerEvent<HTMLDivElement>) => void;
  onPortPointerDown: (id: string, portIndex: number, event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function GraphDomNodes({
  nodes,
  viewport,
  viewMode,
  selectedNodeId,
  viewportSize,
  onNodePointerDown,
  onPortPointerDown,
}: GraphDomNodesProps) {
  const focusPhase = useMemo(() => {
    if (viewMode !== 'fullscreen' || !selectedNodeId) return null;
    if (!viewportSize.width || !viewportSize.height) return null;
    const node = nodes.find((item) => item.id === selectedNodeId);
    if (!node) return null;
    const { fullZoom, midZoom } = getFocusZoomLevels(node, viewportSize);
    if (viewport.zoom >= fullZoom * 0.92) return 'full';
    if (viewport.zoom >= midZoom) return 'mid';
    return null;
  }, [nodes, selectedNodeId, viewMode, viewport.zoom, viewportSize]);

  return (
    <div className={`graph-dom-layer ${viewMode === 'fullscreen' ? 'graph-dom-layer--focused' : ''}`}>
      {nodes.map((node) => {
        const hideForFocus = node.id === selectedNodeId && focusPhase;
        if (hideForFocus) {
          return null;
        }

        const left = node.position.x * viewport.zoom + viewport.x;
        const top = node.position.y * viewport.zoom + viewport.y;
        const transform = `scale(${viewport.zoom})`;
        const isCollapsed = viewMode === 'collapsed';

        return (
          <div
            key={node.id}
            className={`graph-dom-node ${isCollapsed ? 'graph-dom-node--collapsed' : ''}`}
            style={{ width: node.dimensions.width, height: node.dimensions.height, transform, left, top }}
            onPointerDown={(event) => onNodePointerDown(node.id, event)}
          >
            <NodeCard node={node} collapsed={isCollapsed} interactive={false} />
            <button
              className="graph-dom-port graph-dom-port--top"
              type="button"
              onPointerDown={(event) => onPortPointerDown(node.id, 0, event)}
              aria-label="Connect from top port"
            />
            <button
              className="graph-dom-port graph-dom-port--right"
              type="button"
              onPointerDown={(event) => onPortPointerDown(node.id, 1, event)}
              aria-label="Connect from right port"
            />
            <button
              className="graph-dom-port graph-dom-port--bottom"
              type="button"
              onPointerDown={(event) => onPortPointerDown(node.id, 2, event)}
              aria-label="Connect from bottom port"
            />
            <button
              className="graph-dom-port graph-dom-port--left"
              type="button"
              onPointerDown={(event) => onPortPointerDown(node.id, 3, event)}
              aria-label="Connect from left port"
            />
          </div>
        );
      })}
    </div>
  );
}
