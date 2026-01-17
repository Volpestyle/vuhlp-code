/**
 * Status badge component for displaying node status
 */

import type { NodeStatus } from '@vuhlp/contracts';
import './StatusBadge.css';

interface StatusBadgeProps {
  status: NodeStatus;
  size?: 'sm' | 'md';
}

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-badge--${status} status-badge--${size}`}>
      <span className="status-badge__dot" />
      <span className="status-badge__text">{status}</span>
    </span>
  );
}
