/**
 * Node Card component for displaying nodes in the graph
 * Per docs/07-ui-spec.md must show:
 * - Provider badge (Codex/Claude/Gemini)
 * - Role label
 * - Status badge (idle/running/blocked/failed)
 * - Short live summary (3-6 words)
 * - Last activity timestamp
 */

import type { NodeState } from '@vuhlp/contracts';
import { useRunStore } from '../stores/runStore';
import { StatusBadge } from './StatusBadge';
import { ProviderBadge } from './ProviderBadge';
import { formatRelativeTime } from '@vuhlp/shared';
import { Expand } from 'iconoir-react';
import './NodeCard.css';

interface NodeCardProps {
  node: NodeState;
  collapsed?: boolean;
  interactive?: boolean;
}

export function NodeCard({ node, collapsed = false, interactive = true }: NodeCardProps) {
  const selectNode = useRunStore((s) => s.selectNode);
  const selectedNodeId = useRunStore((s) => s.ui.selectedNodeId);
  const isSelected = selectedNodeId === node.id;
  const connectionStatus = node.connection?.status ?? 'disconnected';
  const isStreaming = Boolean(node.connection?.streaming);

  const handleClick = () => {
    if (!interactive) return;
    selectNode(isSelected ? null : node.id);
  };

  const setViewMode = useRunStore((s) => s.setViewMode);

  const handleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectNode(node.id);
    setViewMode('fullscreen');
  };

  if (collapsed) {
    return (
    <div
        className={`node-card node-card--collapsed ${isSelected ? 'node-card--selected' : ''} ${
          interactive ? '' : 'node-card--static'
        }`}
        onClick={interactive ? handleClick : undefined}
      >
        <div className="node-card__collapsed-header">
          <ProviderBadge provider={node.provider} size="sm" />
          <span className="node-card__collapsed-label">{node.label}</span>
          <span
            className={`node-card__connection-inline node-card__connection--${connectionStatus} ${
              isStreaming ? 'node-card__connection--streaming' : ''
            }`}
            title={`Process ${connectionStatus}`}
          >
            <span className="node-card__connection-dot" />
          </span>
          <StatusBadge status={node.status} size="sm" />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`node-card ${isSelected ? 'node-card--selected' : ''} node-card--${node.status} ${
        interactive ? '' : 'node-card--static'
      }`}
      onClick={interactive ? handleClick : undefined}
    >
      {/* Header */}
      <div className="node-card__header">
        <ProviderBadge provider={node.provider} size="sm" />
        <span className="node-card__role">{node.roleTemplate}</span>
        <button 
          className="node-card__expand"
          onClick={handleExpand}
          title="Fullscreen"
        >
          <Expand width={14} height={14} />
        </button>
      </div>

      {/* Title */}
      <h3 className="node-card__title">{node.label}</h3>

      {/* Summary */}
      <p className="node-card__summary">{node.summary || 'Waiting...'}</p>

      {/* Footer */}
      <div className="node-card__footer">
        <StatusBadge status={node.status} size="sm" />
        <span className="node-card__time">{formatRelativeTime(node.lastActivityAt)}</span>
      </div>

      {/* Connection indicator */}
      <div
        className={`node-card__connection node-card__connection--${connectionStatus} ${
          isStreaming ? 'node-card__connection--streaming' : ''
        }`}
        title={`Process ${connectionStatus}`}
      >
        <span className="node-card__connection-dot" />
      </div>

      {/* Inbox count */}
      {node.inboxCount !== undefined && node.inboxCount > 0 && (
        <div className="node-card__inbox">
          {node.inboxCount}
        </div>
      )}
    </div>
  );
}
