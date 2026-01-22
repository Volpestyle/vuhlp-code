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
  onStop?: () => void;
  onRestart?: () => void;
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

function getConnectionStatus(status: Node['status']): { label: string; type: string } {
  if (status === 'running') return { label: 'Worker Connected', type: 'connected' };
  if (status === 'queued') return { label: 'Worker Queued', type: 'queued' };
  if (status === 'failed') return { label: 'Worker Failed', type: 'failed' };
  return { label: 'Worker Disconnected', type: 'disconnected' };
}

/**
 * Window header component with provider logo, label, status, and timing info.
 * Acts as a drag handle for window repositioning.
 */
export function NodeWindowHeader({ node, trackedState, onMouseDown, onStop, onRestart }: NodeWindowHeaderProps) {
  const providerLogo = node.providerId ? PROVIDER_LOGOS[node.providerId] : undefined;
  const typeLabel = node.type ? NODE_TYPE_LABELS[node.type] : null;
  const subtitle = getHeaderSubtitle(trackedState);
  const { label: connectionLabel, type: connectionType } = getConnectionStatus(node.status);
  
  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    onStop?.();
  };

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
          <div className="vuhlp-node-window__subtitle-row">
            <span className={`vuhlp-node-window__connection-status vuhlp-node-window__connection-status--${connectionType}`}>
              <span className="vuhlp-node-window__status-dot" />
              {connectionLabel}
            </span>
            {subtitle && <span className="vuhlp-node-window__subtitle"> • {subtitle}</span>}
          </div>
        </div>
      </div>

      <div className="vuhlp-node-window__header-center">
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

        {onRestart && (node.status === 'completed' || node.status === 'failed' || node.status === 'skipped') && (
          <button
            className="vuhlp-node-window__restart-btn"
            onClick={(e) => {
              e.stopPropagation();
              onRestart();
            }}
            title="Reconnect Worker"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <path d="M5 1a4 4 0 0 0-3.3 1.76l-.9-1.07A.5.5 0 1 0 .04 2.3l1.5 1.8a.5.5 0 0 0 .76.03L3.8 2.6a.5.5 0 0 0-.64-.77l-.95.8A3 3 0 1 1 2 5a.5.5 0 0 0-1 0 4 4 0 1 0 4-4z"/>
              <path d="M4.5 4a.5.5 0 0 0-1 0v3.5a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 0-1H4.5V4z" fillRule="evenodd"/>
            </svg>
          </button>
        )}

        {onStop && node.status === 'running' && (
          <button
            className="vuhlp-node-window__stop-btn"
            onClick={handleStop}
            title="Disconnect Worker"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
              <rect x="0" y="0" width="8" height="8" rx="1.5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
