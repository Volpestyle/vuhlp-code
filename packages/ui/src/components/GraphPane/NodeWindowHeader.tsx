import React from 'react';
import type { Node, NodeTrackedState, NodeType } from '../../types';

const PROVIDER_LOGOS: Record<string, string> = {
  claude: '/claude.svg',
  codex: '/codex.svg',
  gemini: '/gemini.svg',
};

interface NodeWindowHeaderProps {
  node: Node;
  trackedState?: NodeTrackedState;
  onMouseDown: (e: React.MouseEvent) => void;
}

function formatTime(isoString: string): string {
  try {
    return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

const NODE_TYPE_LABELS: Record<NodeType, string> = {
  orchestrator: 'Orch',
  task: 'Task',
  verification: 'Verify',
  merge: 'Merge',
};

function getHeaderSubtitle(trackedState: NodeTrackedState | undefined): string | null {
  if (!trackedState) return null;

  for (let i = trackedState.tools.length - 1; i >= 0; i -= 1) {
    const tool = trackedState.tools[i];
    if (tool.status === 'started') {
      return `Tool: ${tool.name}`;
    }
  }

  const lastEvent = trackedState.events[trackedState.events.length - 1];
  if (lastEvent?.message) {
    return truncate(lastEvent.message, 46);
  }

  const lastMessage = trackedState.messages[trackedState.messages.length - 1];
  if (lastMessage?.content) {
    return truncate(lastMessage.content, 46);
  }

  return null;
}

/**
 * Window header component with provider logo, label, status, and timing info.
 * Acts as a drag handle for window repositioning.
 */
export function NodeWindowHeader({ node, trackedState, onMouseDown }: NodeWindowHeaderProps) {
  const providerLogo = node.providerId ? PROVIDER_LOGOS[node.providerId] : undefined;
  const typeLabel = node.type ? NODE_TYPE_LABELS[node.type] : null;
  const subtitle = getHeaderSubtitle(trackedState);

  return (
    <div className="vuhlp-node-window__header" onMouseDown={onMouseDown}>
      <div className="vuhlp-node-window__header-left">
        {providerLogo && (
          <img
            src={providerLogo}
            alt={node.providerId}
            className="vuhlp-node-window__provider-logo"
          />
        )}
        <div className="vuhlp-node-window__title">
          <span className="vuhlp-node-window__label">{node.label || node.id.slice(0, 8)}</span>
          {subtitle && <span className="vuhlp-node-window__subtitle">{subtitle}</span>}
        </div>
      </div>

      <div className="vuhlp-node-window__header-center">
        <span className={`vuhlp-node-window__status vuhlp-node-window__status--${node.status}`}>
          {node.status}
        </span>
        {typeLabel && (
          <span className={`vuhlp-node-window__type vuhlp-node-window__type--${node.type}`}>
            {typeLabel}
          </span>
        )}
      </div>

      <div className="vuhlp-node-window__header-right">
        {node.startedAt && (
          <span className="vuhlp-node-window__timing" title="Started at">
            {formatTime(node.startedAt)}
          </span>
        )}
        {node.durationMs !== undefined && (
          <span className="vuhlp-node-window__duration" title="Duration">
            {formatDuration(node.durationMs)}
          </span>
        )}
      </div>
    </div>
  );
}
