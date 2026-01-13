import React from 'react';
import type { Node, NodeTrackedState } from '../../types';

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

/**
 * Window header component with provider logo, label, status, and timing info.
 * Acts as a drag handle for window repositioning.
 */
export function NodeWindowHeader({ node, trackedState, onMouseDown }: NodeWindowHeaderProps) {
  const providerLogo = node.providerId ? PROVIDER_LOGOS[node.providerId] : undefined;

  // Node Type Icon
  const getTypeIcon = (type?: string) => {
      switch(type) {
          case 'orchestrator': return '🧠';
          case 'task': return '⚡';
          case 'verification': return '🛡️';
          case 'merge': return '🔀';
          default: return '📄';
      }
  };

  // Activity Summary
  const getSummary = () => {
      if (node.status === 'running') {
          // Check for active tool
          const activeTool = trackedState?.tools?.find(t => t.status === 'started');
          if (activeTool) return `Tool: ${activeTool.name}`;
      }
      return null;
  };

  const summary = getSummary();

  return (
    <div className="vuhlp-node-window__header" onMouseDown={onMouseDown}>
      <div className="vuhlp-node-window__header-left">
        <span className="vuhlp-node-window__type-icon" style={{ fontSize: '14px', marginRight: '4px' }} title={node.type}>
            {getTypeIcon(node.type)}
        </span>
        {providerLogo && (
          <img
            src={providerLogo}
            alt={node.providerId}
            className="vuhlp-node-window__provider-logo"
          />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
             <span className="vuhlp-node-window__label">{node.label || node.id.slice(0, 8)}</span>
             {summary && (
                 <span style={{ fontSize: '10px', color: 'var(--vuhlp-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                     {summary}
                 </span>
             )}
        </div>
      </div>

      <div className="vuhlp-node-window__header-center">
        <span className={`vuhlp-node-window__status vuhlp-node-window__status--${node.status}`}>
          {node.status}
        </span>
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