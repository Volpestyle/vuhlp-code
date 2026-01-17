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

  const formatTime = (iso: string) => {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  };

  const handleClick = () => {
    if (!interactive) return;
    selectNode(isSelected ? null : node.id);
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
      </div>

      {/* Title */}
      <h3 className="node-card__title">{node.label}</h3>

      {/* Summary */}
      <p className="node-card__summary">{node.summary || 'Waiting...'}</p>

      {/* Footer */}
      <div className="node-card__footer">
        <StatusBadge status={node.status} size="sm" />
        <span className="node-card__time">{formatTime(node.lastActivityAt)}</span>
      </div>

      {/* Connection indicator */}
      {node.connection?.streaming && (
        <div className="node-card__streaming">
          <span className="node-card__streaming-dot" />
        </div>
      )}

      {/* Inbox count */}
      {node.inboxCount !== undefined && node.inboxCount > 0 && (
        <div className="node-card__inbox">
          {node.inboxCount}
        </div>
      )}
    </div>
  );
}
