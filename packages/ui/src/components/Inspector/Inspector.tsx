import { useState, useMemo, useRef, useEffect } from 'react';
import type {
  Node,
  Artifact,
  NodeTrackedState,
  ChatMessage,
  ChatTarget,
} from '../../types';
import { Button } from '../Button';
import './Inspector.css';

export interface InspectorProps {
  node: Node | null;
  logs: string[];
  artifacts: Artifact[];
  runId?: string;
  trackedState?: NodeTrackedState;
  canSendMessage?: boolean;
  chatTarget?: ChatTarget;
  chatMessages?: ChatMessage[];
  onSendMessage?: (content: string, interrupt: boolean) => void;
  onQueueMessage?: (content: string) => void;
}

type TabId = 'overview' | 'conversation' | 'tools' | 'files' | 'context' | 'events' | 'console';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'tools', label: 'Tools' },
  { id: 'files', label: 'Files' },
  { id: 'context', label: 'Context' },
  { id: 'events', label: 'Events' },
  { id: 'console', label: 'Console' },
];

export function Inspector({
  node,
  logs,
  artifacts,
  runId: _runId,
  trackedState,
  canSendMessage = false,
  chatTarget,
  chatMessages: _chatMessages = [],
  onSendMessage,
  onQueueMessage,
}: InspectorProps) {
  const [activeTab, setActiveTab] = useState<TabId>('conversation');
  const [chatInput, setChatInput] = useState('');
  const [eventFilter, setEventFilter] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Scroll chat to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [trackedState?.messages]);

  const handleSendMessage = (interrupt: boolean) => {
    if (!chatInput.trim() || !onSendMessage) return;
    onSendMessage(chatInput.trim(), interrupt);
    setChatInput('');
  };

  const handleQueueMessage = () => {
    if (!chatInput.trim() || !onQueueMessage) return;
    onQueueMessage(chatInput.trim());
    setChatInput('');
  };

  // Filter events
  const filteredEvents = useMemo(() => {
    if (!trackedState?.events) return [];
    if (!eventFilter) return trackedState.events;
    const lower = eventFilter.toLowerCase();
    return trackedState.events.filter(
      (e) =>
        e.type.toLowerCase().includes(lower) ||
        e.message.toLowerCase().includes(lower)
    );
  }, [trackedState?.events, eventFilter]);

  // Extract file changes from artifacts
  const fileArtifacts = useMemo(() => {
    return artifacts.filter((a) => a.type === 'diff' || a.type === 'file_changes');
  }, [artifacts]);

  if (!node) {
    return (
      <div className="vuhlp-inspector vuhlp-inspector--empty">
        <div className="vuhlp-inspector__empty-state">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="8" y="8" width="32" height="32" rx="2" />
            <path d="M16 20h16M16 28h10" strokeLinecap="round" />
          </svg>
          <p>Select a node to inspect</p>
        </div>
      </div>
    );
  }

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <div className="vuhlp-inspector">
      {/* Header */}
      <div className="vuhlp-inspector__header">
        <div className="vuhlp-inspector__node-info">
          <span className={`vuhlp-inspector__status vuhlp-inspector__status--${node.status}`} />
          <span className="vuhlp-inspector__label">{node.label}</span>
          {node.providerId && (
            <span className={`vuhlp-inspector__provider vuhlp-inspector__provider--${node.providerId}`}>
              {node.providerId}
            </span>
          )}
        </div>
        {node.type && (
          <span className="vuhlp-inspector__type">{node.type}</span>
        )}
      </div>

      {/* Tabs */}
      <div className="vuhlp-inspector__tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`vuhlp-inspector__tab ${activeTab === tab.id ? 'vuhlp-inspector__tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {tab.id === 'tools' && trackedState?.tools && trackedState.tools.length > 0 && (
              <span className="vuhlp-inspector__tab-badge">{trackedState.tools.length}</span>
            )}
            {tab.id === 'events' && trackedState?.events && trackedState.events.length > 0 && (
              <span className="vuhlp-inspector__tab-badge">{trackedState.events.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="vuhlp-inspector__content">
        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="vuhlp-inspector__overview">
            <div className="vuhlp-inspector__section">
              <h3 className="vuhlp-inspector__section-title">Details</h3>
              <div className="vuhlp-inspector__details">
                <div className="vuhlp-inspector__detail">
                  <span className="vuhlp-inspector__detail-label">ID</span>
                  <span className="vuhlp-inspector__detail-value vuhlp-mono">{node.id}</span>
                </div>
                <div className="vuhlp-inspector__detail">
                  <span className="vuhlp-inspector__detail-label">Status</span>
                  <span className={`vuhlp-inspector__detail-value vuhlp-inspector__status-text--${node.status}`}>
                    {node.status}
                  </span>
                </div>
                {node.startedAt && (
                  <div className="vuhlp-inspector__detail">
                    <span className="vuhlp-inspector__detail-label">Started</span>
                    <span className="vuhlp-inspector__detail-value">{formatTime(node.startedAt)}</span>
                  </div>
                )}
                {node.durationMs !== undefined && (
                  <div className="vuhlp-inspector__detail">
                    <span className="vuhlp-inspector__detail-label">Duration</span>
                    <span className="vuhlp-inspector__detail-value">{formatDuration(node.durationMs)}</span>
                  </div>
                )}
              </div>
            </div>

            {logs.length > 0 && (
              <div className="vuhlp-inspector__section">
                <h3 className="vuhlp-inspector__section-title">Progress Log</h3>
                <div className="vuhlp-inspector__log">
                  {logs.slice(-20).map((line, i) => (
                    <div key={i} className="vuhlp-inspector__log-line">{line}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Conversation Tab */}
        {activeTab === 'conversation' && (
          <div className="vuhlp-inspector__conversation">
            <div className="vuhlp-inspector__messages">
              {(!trackedState?.messages || trackedState.messages.length === 0) ? (
                <div className="vuhlp-inspector__messages-empty">No messages yet</div>
              ) : (
                trackedState.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`vuhlp-inspector__message vuhlp-inspector__message--${msg.type}`}
                  >
                    <div className="vuhlp-inspector__message-header">
                      <span className="vuhlp-inspector__message-role">{msg.type}</span>
                      <span className="vuhlp-inspector__message-time">{formatTime(msg.timestamp)}</span>
                    </div>
                    <div className="vuhlp-inspector__message-content">
                      {msg.content}
                      {msg.isPartial && <span className="vuhlp-inspector__typing" />}
                    </div>
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>

            {canSendMessage && onSendMessage && (
              <div className="vuhlp-inspector__chat-input">
                {chatTarget && (
                  <div className="vuhlp-inspector__chat-target">
                    Chatting with: <strong>{chatTarget.label}</strong>
                  </div>
                )}
                <div className="vuhlp-inspector__chat-form">
                  <textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Type a message..."
                    className="vuhlp-inspector__chat-textarea"
                    rows={2}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage(true);
                      }
                    }}
                  />
                  <div className="vuhlp-inspector__chat-actions">
                    <Button variant="ghost" size="sm" onClick={handleQueueMessage} disabled={!chatInput.trim()}>
                      Queue
                    </Button>
                    <Button variant="primary" size="sm" onClick={() => handleSendMessage(true)} disabled={!chatInput.trim()}>
                      Send & Interrupt
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tools Tab */}
        {activeTab === 'tools' && (
          <div className="vuhlp-inspector__tools">
            {(!trackedState?.tools || trackedState.tools.length === 0) ? (
              <div className="vuhlp-inspector__tools-empty">No tools executed</div>
            ) : (
              <div className="vuhlp-inspector__tools-list">
                {trackedState.tools.map((tool) => (
                  <div key={tool.id} className={`vuhlp-inspector__tool vuhlp-inspector__tool--${tool.status}`}>
                    <div className="vuhlp-inspector__tool-header">
                      <span className={`vuhlp-inspector__tool-risk vuhlp-inspector__tool-risk--${tool.riskLevel}`}>
                        {tool.riskLevel}
                      </span>
                      <span className="vuhlp-inspector__tool-name">{tool.name}</span>
                      <span className="vuhlp-inspector__tool-status">{tool.status}</span>
                      {tool.durationMs !== undefined && (
                        <span className="vuhlp-inspector__tool-duration">{formatDuration(tool.durationMs)}</span>
                      )}
                    </div>
                    <div className="vuhlp-inspector__tool-args">
                      <pre>{JSON.stringify(tool.args, null, 2)}</pre>
                    </div>
                    {tool.result !== undefined && (
                      <div className="vuhlp-inspector__tool-result">
                        <span className="vuhlp-inspector__tool-result-label">Result:</span>
                        <pre>{typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}</pre>
                      </div>
                    )}
                    {tool.error && (
                      <div className="vuhlp-inspector__tool-error">
                        Error: {tool.error.message}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Files Tab */}
        {activeTab === 'files' && (
          <div className="vuhlp-inspector__files">
            {fileArtifacts.length === 0 ? (
              <div className="vuhlp-inspector__files-empty">No file changes</div>
            ) : (
              <div className="vuhlp-inspector__files-list">
                {fileArtifacts.map((artifact) => (
                  <div key={artifact.id} className="vuhlp-inspector__file">
                    <div className="vuhlp-inspector__file-header">
                      <span className="vuhlp-inspector__file-name">{artifact.name}</span>
                      <span className="vuhlp-inspector__file-type">{artifact.type}</span>
                    </div>
                    {artifact.content && (
                      <pre className="vuhlp-inspector__file-diff">{artifact.content}</pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Context Tab */}
        {activeTab === 'context' && (
          <div className="vuhlp-inspector__context">
            {node.instructions && (
              <div className="vuhlp-inspector__section">
                <h3 className="vuhlp-inspector__section-title">Instructions</h3>
                <div className="vuhlp-inspector__context-content">
                  {node.instructions}
                </div>
              </div>
            )}
            {node.context && (
              <div className="vuhlp-inspector__section">
                <h3 className="vuhlp-inspector__section-title">Context</h3>
                <pre className="vuhlp-inspector__context-content">{node.context}</pre>
              </div>
            )}
            {!node.instructions && !node.context && (
              <div className="vuhlp-inspector__context-empty">No context available</div>
            )}
          </div>
        )}

        {/* Events Tab */}
        {activeTab === 'events' && (
          <div className="vuhlp-inspector__events">
            <div className="vuhlp-inspector__events-filter">
              <input
                type="text"
                value={eventFilter}
                onChange={(e) => setEventFilter(e.target.value)}
                placeholder="Filter events..."
                className="vuhlp-inspector__events-input"
              />
            </div>
            <div className="vuhlp-inspector__events-list">
              {filteredEvents.length === 0 ? (
                <div className="vuhlp-inspector__events-empty">No events</div>
              ) : (
                filteredEvents.map((event) => (
                  <div key={event.id} className="vuhlp-inspector__event">
                    <span className="vuhlp-inspector__event-time">{formatTime(event.timestamp)}</span>
                    <span className="vuhlp-inspector__event-type">{event.type}</span>
                    <span className="vuhlp-inspector__event-message">{event.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Console Tab */}
        {activeTab === 'console' && (
          <div className="vuhlp-inspector__console">
            {(!trackedState?.consoleChunks || trackedState.consoleChunks.length === 0) ? (
              <div className="vuhlp-inspector__console-empty">No console output</div>
            ) : (
              <pre className="vuhlp-inspector__console-output">
                {trackedState.consoleChunks.map((chunk) => (
                  <span
                    key={chunk.id}
                    className={`vuhlp-inspector__console-chunk vuhlp-inspector__console-chunk--${chunk.stream}`}
                  >
                    {chunk.data}
                  </span>
                ))}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
