import { useState, useMemo, useRef, useEffect, ReactNode } from 'react';
import type {
  Node,
  Artifact,
  NodeTrackedState,
  ChatMessage,
  ChatTarget,
  Edge,
} from '../../types';
import { Button } from '../Button';
import { parseMessageContent, formatJsonWithHighlight, getStatusClass } from '../utils/messageParser';
import { MarkdownContent } from '../utils/MarkdownContent';
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
  // Connection Management
  nodes?: Node[];
  edges?: Edge[];
  onAddConnection?: (sourceId: string, targetId: string) => void;
  onRemoveConnection?: (edgeId: string) => void;
  onGroupChanges?: () => void;
  // Node Editing
  providers?: Array<{ id: string; displayName: string }>;
  onUpdateNode?: (runId: string, nodeId: string, updates: Record<string, unknown>) => void;
  // Git repository status
  isGitRepo?: boolean;
}

type TabId = 'overview' | 'conversation' | 'graph' | 'tools' | 'files' | 'context' | 'events' | 'console';

// Component to render parsed message content
function MessageContent({ content }: { content: string }): ReactNode {
  const segments = useMemo(() => parseMessageContent(content), [content]);

  if (segments.length === 0) {
    return null;
  }

  return (
    <>
      {segments.map((segment, idx) => {
        switch (segment.type) {
          case 'status':
            return (
              <div key={idx} className="vuhlp-inspector__status-block">
                {segment.data && Object.entries(segment.data).map(([key, value]) => (
                  <span
                    key={key}
                    className={`vuhlp-inspector__status-badge ${getStatusClass(String(value))}`}
                  >
                    {key}: {String(value)}
                  </span>
                ))}
              </div>
            );

          case 'json':
            return (
              <pre key={idx} className="vuhlp-inspector__json-block">
                {formatJsonWithHighlight(segment.data || segment.content)}
              </pre>
            );

          case 'code':
            return (
              <pre key={idx} className="vuhlp-inspector__code-block">
                <code>{segment.content}</code>
              </pre>
            );

          case 'text':
          default:
            return <MarkdownContent key={idx} content={segment.content} />;
        }
      })}
    </>
  );
}

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'graph', label: 'Graph' },
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
  chatMessages = [],
  onSendMessage,
  onQueueMessage,
  nodes = [],
  edges = [],
  onAddConnection,
  onRemoveConnection,
  onGroupChanges,
  providers = [],
  onUpdateNode,
  isGitRepo,
}: InspectorProps) {
  const [activeTab, setActiveTab] = useState<TabId>('conversation');
  const [chatInput, setChatInput] = useState('');
  const [eventFilter, setEventFilter] = useState('');
  const [newInputNodeId, setNewInputNodeId] = useState('');
  const [newOutputNodeId, setNewOutputNodeId] = useState('');
  const [isEditingProvider, setIsEditingProvider] = useState(false);
  const [gitInitStatus, setGitInitStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [gitInitError, setGitInitError] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  // Smart auto-scroll: only scroll if user was already near the bottom
  useEffect(() => {
    const container = messagesRef.current;
    if (!container) {
      // Fallback if ref not yet attached (initial render)
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    // Check if we are close to the bottom (within 100px)
    const isCloseToBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 100;
    
    if (isCloseToBottom) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, node?.status]);

  const handleSendMessage = (interrupt: boolean) => {
    if (!chatInput.trim() || !onSendMessage) return;
    onSendMessage(chatInput.trim(), interrupt);
    setChatInput('');
    // Always force scroll to bottom when user sends a message
    setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 10);
  };

  const handleQueueMessage = () => {
    if (!chatInput.trim() || !onQueueMessage) return;
    onQueueMessage(chatInput.trim());
    setChatInput('');
    setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 10);
  };

  const handleInitGitRepo = async () => {
    if (!_runId) {
      setGitInitError('No active run');
      setGitInitStatus('error');
      return;
    }

    setGitInitStatus('loading');
    setGitInitError('');

    try {
      const res = await fetch(`/api/runs/${_runId}/git/init`, { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to initialize git repo');
      }

      setGitInitStatus('success');
    } catch (e) {
      console.error(e);
      setGitInitStatus('error');
      setGitInitError(e instanceof Error ? e.message : String(e));
    }
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

  // Graph connections
  const { inboundEdges, outboundEdges, availableInputNodes, availableOutputNodes } = useMemo(() => {
    if (!node) {
      return {
        inboundEdges: [],
        outboundEdges: [],
        availableInputNodes: [],
        availableOutputNodes: [],
      };
    }

    const inbound = edges.filter((e) => e.target === node.id);
    const outbound = edges.filter((e) => e.source === node.id);

    const connectedInputIds = new Set(inbound.map((e) => e.source));
    const connectedOutputIds = new Set(outbound.map((e) => e.target));
    
    // Nodes that can be inputs (not self, not already connected)
    const availableInputs = nodes.filter(
      (n) => n.id !== node.id && !connectedInputIds.has(n.id)
    );

    // Nodes that can be outputs (not self, not already connected)
    const availableOutputs = nodes.filter(
      (n) => n.id !== node.id && !connectedOutputIds.has(n.id)
    );

    return {
      inboundEdges: inbound,
      outboundEdges: outbound,
      availableInputNodes: availableInputs,
      availableOutputNodes: availableOutputs,
    };
  }, [node, nodes, edges]);

  const handleAddInput = () => {
    if (newInputNodeId && onAddConnection && node) {
      onAddConnection(newInputNodeId, node.id);
      setNewInputNodeId('');
    }
  };

  const handleAddOutput = () => {
    if (newOutputNodeId && onAddConnection && node) {
      onAddConnection(node.id, newOutputNodeId);
      setNewOutputNodeId('');
    }
  };

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
          {isEditingProvider && onUpdateNode && _runId ? (
            <select
              className="inspector-select"
              value={node.providerId || 'mock'}
              onChange={(e) => {
                onUpdateNode(_runId, node.id, { providerId: e.target.value });
                setIsEditingProvider(false);
              }}
              onBlur={() => setIsEditingProvider(false)}
              autoFocus
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          ) : (
            node.providerId && (
              <span 
                className={`vuhlp-inspector__provider vuhlp-inspector__provider--${node.providerId} ${onUpdateNode ? 'clickable' : ''}`}
                onClick={() => onUpdateNode && setIsEditingProvider(true)}
                title={onUpdateNode ? "Click to change provider" : undefined}
              >
                {node.providerId}
              </span>
            )
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
            <div className="vuhlp-inspector__messages" ref={messagesRef}>
              {(() => {
                // Filter messages for current node or run-level
                // If viewing a specific node, show messages for that node + run-level messages
                // If viewing orchestrator (or no specific node), show all messages? Or just run-level?
                // For now: Node view = Node messages + Run messages
                const relevantMessages = (chatMessages || []).filter((m: ChatMessage) => {
                  if (!node) return true;
                  return m.nodeId === node.id || !m.nodeId;
                }).sort((a: ChatMessage, b: ChatMessage) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

                // Deduplicate by ID just in case
                const uniqueMessages = Array.from(new Map(relevantMessages.map((m: ChatMessage) => [m.id, m])).values());

                if (uniqueMessages.length === 0) {
                  return <div className="vuhlp-inspector__messages-empty">No messages yet</div>;
                }

                return uniqueMessages.map((msg: ChatMessage) => (
                  <div
                    key={msg.id}
                    className={`vuhlp-inspector__message vuhlp-inspector__message--${msg.role}`}
                  >
                    <div className="vuhlp-inspector__message-header">
                      <span className="vuhlp-inspector__message-role">{msg.role}</span>
                      <span className="vuhlp-inspector__message-time">
                        {formatTime(msg.timestamp)}
                      </span>
                    </div>
                    <div className="vuhlp-inspector__message-content">
                      <MessageContent content={msg.content} />
                    </div>
                  </div>
                ));
              })()}
              {node?.status === 'running' && (
                <div className="vuhlp-inspector__message vuhlp-inspector__message--assistant">
                  <div className="vuhlp-inspector__message-header">
                    <span className="vuhlp-inspector__message-role">assistant</span>
                  </div>
                  <div className="vuhlp-inspector__message-content">
                    <span className="vuhlp-inspector__loading-dots">Thinking...</span>
                  </div>
                </div>
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

        {/* Graph Tab */}
        {activeTab === 'graph' && (
          <div className="vuhlp-inspector__overview">
            <div className="vuhlp-inspector__section">
              <h3 className="vuhlp-inspector__section-title">Inbound Connections</h3>
              
              <div className="vuhlp-inspector__connections-list">
                {inboundEdges.length === 0 && (
                  <div className="vuhlp-inspector__empty-text">No inbound connections</div>
                )}
                {inboundEdges.map((edge) => {
                  const sourceNode = nodes.find(n => n.id === edge.source);
                  return (
                    <div key={edge.id} className="vuhlp-inspector__connection-item">
                      <div className="vuhlp-inspector__connection-info">
                        <span className="vuhlp-inspector__connection-node">
                          {sourceNode?.label || edge.source}
                        </span>
                        <span className="vuhlp-inspector__connection-type">{edge.type}</span>
                      </div>
                      {onRemoveConnection && (
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => onRemoveConnection(edge.id)}
                          className="vuhlp-inspector__connection-remove"
                        >
                          Disconnect
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>

              {onAddConnection && availableInputNodes.length > 0 && (
                <div className="vuhlp-inspector__add-connection">
                  <select
                    value={newInputNodeId}
                    onChange={(e) => setNewInputNodeId(e.target.value)}
                    className="vuhlp-inspector__select"
                  >
                    <option value="">Select source node...</option>
                    {availableInputNodes.map((n) => (
                      <option key={n.id} value={n.id}>{n.label}</option>
                    ))}
                  </select>
                  <Button 
                    variant="secondary" 
                    size="sm"
                    disabled={!newInputNodeId}
                    onClick={handleAddInput}
                  >
                    Add Input
                  </Button>
                </div>
              )}
            </div>

            <div className="vuhlp-inspector__section">
              <h3 className="vuhlp-inspector__section-title">Outbound Connections</h3>

              <div className="vuhlp-inspector__connections-list">
                {outboundEdges.length === 0 && (
                  <div className="vuhlp-inspector__empty-text">No outbound connections</div>
                )}
                {outboundEdges.map((edge) => {
                  const targetNode = nodes.find(n => n.id === edge.target);
                  return (
                    <div key={edge.id} className="vuhlp-inspector__connection-item">
                      <div className="vuhlp-inspector__connection-info">
                        <span className="vuhlp-inspector__connection-node">
                          {targetNode?.label || edge.target}
                        </span>
                        <span className="vuhlp-inspector__connection-type">{edge.type}</span>
                      </div>
                      {onRemoveConnection && (
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => onRemoveConnection(edge.id)}
                          className="vuhlp-inspector__connection-remove"
                        >
                          Disconnect
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>

              {onAddConnection && availableOutputNodes.length > 0 && (
                <div className="vuhlp-inspector__add-connection">
                  <select
                    value={newOutputNodeId}
                    onChange={(e) => setNewOutputNodeId(e.target.value)}
                    className="vuhlp-inspector__select"
                  >
                    <option value="">Select target node...</option>
                    {availableOutputNodes.map((n) => (
                      <option key={n.id} value={n.id}>{n.label}</option>
                    ))}
                  </select>
                  <Button 
                    variant="secondary" 
                    size="sm"
                    disabled={!newOutputNodeId}
                    onClick={handleAddOutput}
                  >
                    Add Output
                  </Button>
                </div>
              )}
            </div>
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
            {/* Git Repository Status */}
            {isGitRepo === false && (
              <div className="vuhlp-inspector__section vuhlp-inspector__section--warning">
                <h3 className="vuhlp-inspector__section-title">Repository Status</h3>
                <div className="vuhlp-inspector__git-status">
                  <div className="vuhlp-inspector__warning-text">
                    No Git repository initialized
                  </div>
                  {gitInitStatus !== 'success' && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleInitGitRepo}
                      disabled={gitInitStatus === 'loading'}
                    >
                      {gitInitStatus === 'loading' ? 'Initializing...' : 'Initialize Git Repo'}
                    </Button>
                  )}
                  {gitInitStatus === 'error' && (
                    <div className="vuhlp-inspector__error-text">{gitInitError}</div>
                  )}
                </div>
              </div>
            )}

            {onGroupChanges && fileArtifacts.length > 0 && (
              <div style={{ marginBottom: 'var(--vuhlp-space-3)', display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="secondary" size="sm" onClick={onGroupChanges}>
                  Group Changes & Commit
                </Button>
              </div>
            )}
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
