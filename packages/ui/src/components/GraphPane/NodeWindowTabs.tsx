import { useState, useEffect, useRef, useMemo, useCallback, ReactNode } from 'react';
import type { NodeTrackedState, MessageEvent, ToolEvent, GenericEvent, ConsoleChunk, Node, Artifact } from '../../types';
import { renderAnsi } from './ansiParser';
import { parseMessageContent, formatJsonWithHighlight, summarizeJsonForDisplay, getStatusClass } from '../utils/messageParser';
import { MarkdownContent } from '../utils/MarkdownContent';

type TabType = 'terminal' | 'stats';

interface NodeWindowTabsProps {
  trackedState: NodeTrackedState | undefined;
  node: Node;
  artifacts?: Artifact[];
  onMessage?: (content: string) => void;
  isInteractive?: boolean;
}

function formatTime(isoString: string): string {
  try {
    return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

// Format JSON with syntax highlighting
function formatJson(data: unknown): ReactNode {
  if (data === null || data === undefined) return null;

  try {
    const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    // Simple syntax highlighting for JSON
    const highlighted = str
      .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
      .replace(/: "([^"]*)"/g, ': <span class="json-string">"$1"</span>')
      .replace(/: (\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
      .replace(/: (true|false)/g, ': <span class="json-boolean">$1</span>')
      .replace(/: (null)/g, ': <span class="json-null">$1</span>');

    return <span dangerouslySetInnerHTML={{ __html: highlighted }} />;
  } catch {
    return String(data);
  }
}

// Truncate long strings with expand option
function TruncatedText({ text, maxLength = 500 }: { text: string; maxLength?: number }) {
  const [expanded, setExpanded] = useState(false);

  if (text.length <= maxLength) {
    return <>{text}</>;
  }

  return (
    <>
      {expanded ? text : text.slice(0, maxLength)}
      <button
        className="term-expand-btn"
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
      >
        {expanded ? '...show less' : `...show ${text.length - maxLength} more`}
      </button>
    </>
  );
}

// Collapsible JSON block for large JSON objects
function CollapsibleJsonBlock({ data, rawContent }: { data: Record<string, unknown>; rawContent: string }) {
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  // Pretty print the JSON (full version)
  const prettyJson = useMemo(() => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return rawContent;
    }
  }, [data, rawContent]);

  // Summarized version (truncates long strings)
  const summarizedJson = useMemo(() => {
    return summarizeJsonForDisplay(data, 80);
  }, [data]);

  const isLarge = prettyJson.length > 200 || prettyJson.split('\n').length > 6;
  const hasLongStrings = prettyJson.length > summarizedJson.length + 50;

  // Get a preview - first few keys or truncated
  const preview = useMemo(() => {
    const keys = Object.keys(data);
    if (keys.length === 0) return '{}';
    const previewKeys = keys.slice(0, 3).map(k => `"${k}"`).join(', ');
    return `{ ${previewKeys}${keys.length > 3 ? ', ...' : ''} }`;
  }, [data]);

  // Count properties for the label
  const propCount = Object.keys(data).length;

  if (!isLarge) {
    // Small JSON - just show it formatted
    return (
      <pre className="term-json-block">
        {formatJsonWithHighlight(prettyJson)}
      </pre>
    );
  }

  return (
    <div className="term-json-collapsible">
      <button
        className="term-json-collapsible__toggle"
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
      >
        <span className={`term-json-collapsible__arrow ${expanded ? 'expanded' : ''}`}>▶</span>
        <span className="term-json-collapsible__label">JSON</span>
        <span className="term-json-collapsible__count">{propCount} properties</span>
        {!expanded && (
          <span className="term-json-collapsible__preview">{preview}</span>
        )}
      </button>
      {expanded && (
        <div className="term-json-expanded-container">
          {hasLongStrings && (
            <div className="term-json-view-toggle">
              <button
                className={`term-json-view-btn ${!showRaw ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setShowRaw(false); }}
              >
                Summary
              </button>
              <button
                className={`term-json-view-btn ${showRaw ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setShowRaw(true); }}
              >
                Raw
              </button>
            </div>
          )}
          <pre className="term-json-block term-json-block--expanded">
            {formatJsonWithHighlight(showRaw ? prettyJson : summarizedJson)}
          </pre>
        </div>
      )}
    </div>
  );
}

// Collapsible block for Reasoning/Thinking content
function CollapsibleReasoningBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);

  // Generate a preview of the reasoning
  const preview = useMemo(() => {
    const lines = content.split('\n');
    const firstLine = lines[0].trim();
    if (firstLine.length > 60) {
      return firstLine.slice(0, 60) + '...';
    }
    return firstLine;
  }, [content]);

  return (
    <div className="term-reasoning-collapsible">
      <button
        className="term-reasoning-toggle"
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
      >
        <span className={`term-reasoning-arrow ${expanded ? 'expanded' : ''}`}>▶</span>
        <span className="term-reasoning-label">Thinking Process</span>
        {!expanded && <span className="term-reasoning-preview">{preview}</span>}
      </button>
      {expanded && (
        <div className="term-reasoning-content">
          {content}
        </div>
      )}
    </div>
  );
}

// Tool status icons mapping (unicode symbols, no emojis)
const TOOL_STATUS_ICONS: Record<string, string> = {
  proposed: '○',
  started: '◐',
  completed: '●',
  failed: '×',
};

// Tool type to CSS class mapping for iconography
const TOOL_ICON_CLASS: Record<string, string> = {
  Read: 'icon-read',
  Write: 'icon-write',
  Edit: 'icon-edit',
  Bash: 'icon-bash',
  Glob: 'icon-glob',
  Grep: 'icon-grep',
  Task: 'icon-task',
  WebFetch: 'icon-web',
  WebSearch: 'icon-search',
  LSP: 'icon-lsp',
  TodoWrite: 'icon-todo',
};

// ----------------------------------------------------------------------------
// Terminal Item Components
// ----------------------------------------------------------------------------

interface MessageBlockProps {
  msg: MessageEvent;
  isPending?: boolean;
}

// Render parsed message content with proper UI for JSON/status blocks
function ParsedMessageContent({ content }: { content: string }): ReactNode {
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
              <div key={idx} className="term-status-block">
                {segment.data && Object.entries(segment.data).map(([key, value]) => (
                  <span
                    key={key}
                    className={`term-status-badge ${getStatusClass(String(value))}`}
                  >
                    {key}: {String(value)}
                  </span>
                ))}
              </div>
            );

          case 'json':
            // Use collapsible block for JSON
            if (segment.data) {
              return (
                <CollapsibleJsonBlock
                  key={idx}
                  data={segment.data}
                  rawContent={segment.content}
                />
              );
            }
            return (
              <pre key={idx} className="term-json-block">
                {formatJsonWithHighlight(segment.content)}
              </pre>
            );

          case 'code':
            return (
              <pre key={idx} className="term-code-block">
                <code>{segment.content}</code>
              </pre>
            );

          case 'text':
          default:
            // For long text, use truncation
            const text = segment.content;
            // Effectively disable truncation for normal messages by setting a very high limit
            if (text.length > 500000) {
              return <TruncatedText key={idx} text={text} maxLength={500000} />;
            }
            // Render markdown for assistant messages
            return <MarkdownContent key={idx} content={text} />;
        }
      })}
    </>
  );
}

function MessageBlock({ msg, isPending }: MessageBlockProps) {
  const isUser = msg.type === 'user';
  const isAssistant = msg.type === 'assistant';
  const isReasoning = msg.type === 'reasoning';

  const roleLabel = isUser ? 'HUMAN' : isAssistant ? 'Assistant' : 'Thinking';
  const roleClass = isUser ? 'user' : isAssistant ? 'assistant' : 'reasoning';

  return (
    <div className={`term-block term-msg term-msg--${roleClass} ${isPending ? 'pending' : ''}`}>
      <div className="term-msg__header">
        <span className={`term-msg__role term-msg__role--${roleClass}`}>
          {roleLabel}
        </span>
        <span className="term-msg__time">{formatTime(msg.timestamp)}</span>
      </div>
      <div className="term-msg__content">
        {isReasoning ? (
            <CollapsibleReasoningBlock content={msg.content} />
        ) : (
          <ParsedMessageContent content={msg.content} />
        )}
        {msg.isPartial && <span className="term-cursor">▌</span>}
      </div>
    </div>
  );
}

interface ToolBlockProps {
  tool: ToolEvent;
}

function ToolBlock({ tool }: ToolBlockProps) {
  const [argsExpanded, setArgsExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);

  const iconClass = TOOL_ICON_CLASS[tool.name] || 'icon-tool';
  const statusIcon = TOOL_STATUS_ICONS[tool.status] || '○';

  // Determine if args/result are long enough to warrant collapsing
  const argsStr = JSON.stringify(tool.args, null, 2);
  const resultStr = tool.result ? JSON.stringify(tool.result, null, 2) : '';
  const isArgsLong = argsStr.length > 200;
  const isResultLong = resultStr.length > 300;

  // Get primary arg for preview (e.g., file_path, command, pattern)
  const primaryArg = tool.args?.file_path || tool.args?.command || tool.args?.pattern || tool.args?.query || null;

  return (
    <div className={`term-block term-tool term-tool--${tool.status}`}>
      <div className="term-tool__header">
        <span className={`term-tool__status term-tool__status--${tool.status}`}>
          {statusIcon}
        </span>
        <span className={`term-tool__icon ${iconClass}`} />
        <span className="term-tool__name">{tool.name}</span>
        {primaryArg && (
          <span className="term-tool__preview">
            {typeof primaryArg === 'string'
              ? primaryArg.length > 50
                ? `${primaryArg.slice(0, 50)}...`
                : primaryArg
              : ''}
          </span>
        )}
        <span className="term-tool__time">{formatTime(tool.timestamp)}</span>
      </div>

      {/* Args section */}
      {!!tool.args && Object.keys(tool.args).length > 0 && (
        <div className="term-tool__section">
          {isArgsLong ? (
            <>
              <button
                className="term-tool__toggle"
                onClick={(e) => { e.stopPropagation(); setArgsExpanded(!argsExpanded); }}
              >
                <span className={`term-tool__arrow ${argsExpanded ? 'expanded' : ''}`}>▶</span>
                <span className="term-tool__label">Arguments</span>
              </button>
              {argsExpanded && (
                <pre className="term-tool__code">{formatJson(tool.args)}</pre>
              )}
            </>
          ) : (
            <pre className="term-tool__code term-tool__code--inline">{formatJson(tool.args)}</pre>
          )}
        </div>
      )}

      {/* Result section */}
      {!!tool.result && (
        <div className="term-tool__section term-tool__section--result">
          {isResultLong ? (
            <>
              <button
                className="term-tool__toggle"
                onClick={(e) => { e.stopPropagation(); setResultExpanded(!resultExpanded); }}
              >
                <span className={`term-tool__arrow ${resultExpanded ? 'expanded' : ''}`}>▶</span>
                <span className="term-tool__label term-tool__label--success">Result</span>
              </button>
              {resultExpanded && (
                <pre className="term-tool__code term-tool__code--result">
                  {typeof tool.result === 'string' ? tool.result : formatJson(tool.result)}
                </pre>
              )}
            </>
          ) : (
            <pre className="term-tool__code term-tool__code--inline term-tool__code--result">
              {typeof tool.result === 'string' ? tool.result : formatJson(tool.result)}
            </pre>
          )}
        </div>
      )}

      {/* Error section */}
      {tool.error && (
        <div className="term-tool__section term-tool__section--error">
          <span className="term-tool__error-icon" />
          <span className="term-tool__error-msg">{tool.error.message}</span>
        </div>
      )}
    </div>
  );
}

interface ConsoleBlockProps {
  chunks: ConsoleChunk[];
}

function ConsoleBlock({ chunks }: ConsoleBlockProps) {
  // Combine consecutive chunks
  const combinedText = chunks.map(c => c.data).join('');
  const hasStderr = chunks.some(c => c.stream === 'stderr');

  // Parse the console output for JSON blocks
  const segments = useMemo(() => parseMessageContent(combinedText), [combinedText]);

  // Check if we have any JSON segments
  const hasJson = segments.some(s => s.type === 'json');

  // If no JSON detected, render normally with ANSI
  if (!hasJson) {
    return (
      <div className={`term-block term-console ${hasStderr ? 'term-console--stderr' : ''}`}>
        <pre className="term-console__output">
          {renderAnsi(combinedText)}
        </pre>
      </div>
    );
  }

  // Render with JSON blocks collapsed
  return (
    <div className={`term-block term-console ${hasStderr ? 'term-console--stderr' : ''}`}>
      <div className="term-console__parsed">
        {segments.map((segment, idx) => {
          if (segment.type === 'json' && segment.data) {
            return (
              <CollapsibleJsonBlock
                key={idx}
                data={segment.data}
                rawContent={segment.content}
              />
            );
          }
          // For text segments, render with ANSI support
          return (
            <pre key={idx} className="term-console__output">
              {renderAnsi(segment.content)}
            </pre>
          );
        })}
      </div>
    </div>
  );
}

interface EventBlockProps {
  event: GenericEvent;
}

function EventBlock({ event }: EventBlockProps) {
  return (
    <div className="term-block term-event">
      <span className="term-event__time">{formatTime(event.timestamp)}</span>
      <span className="term-event__msg">{event.message}</span>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Terminal Tab
// ----------------------------------------------------------------------------

type TerminalItem =
  | { kind: 'message'; data: MessageEvent; timestamp: number; isPending?: boolean }
  | { kind: 'tool'; data: ToolEvent; timestamp: number }
  | { kind: 'console'; data: ConsoleChunk[]; timestamp: number }
  | { kind: 'event'; data: GenericEvent; timestamp: number };

function TerminalTab({
  trackedState,
  onMessage,
  isInteractive,
}: {
  trackedState: NodeTrackedState | undefined;
  onMessage?: (content: string) => void;
  isInteractive?: boolean;
}) {
  const [inputValue, setInputValue] = useState('');
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Track pending messages for optimistic updates
  const [pendingMessages, setPendingMessages] = useState<MessageEvent[]>([]);

  // Clear pending messages when they appear in the real history
  useEffect(() => {
    if (!trackedState || pendingMessages.length === 0) return;
    
    // Check if pending messages have effectively been synced
    // We match on content and roughly on timestamp (newer than pending)
    const realMessages = new Set(trackedState.messages.map(m => m.content));
    setPendingMessages(prev => prev.filter(p => !realMessages.has(p.content)));
  }, [trackedState?.messages, pendingMessages.length]);

  // Group console chunks that are close together (within 100ms)
  const groupConsoleChunks = useCallback((chunks: ConsoleChunk[]): ConsoleChunk[][] => {
    if (chunks.length === 0) return [];

    const groups: ConsoleChunk[][] = [];
    let currentGroup: ConsoleChunk[] = [chunks[0]];

    for (let i = 1; i < chunks.length; i++) {
      const prevTime = new Date(chunks[i - 1].timestamp).getTime();
      const currTime = new Date(chunks[i].timestamp).getTime();

      if (currTime - prevTime < 100) {
        currentGroup.push(chunks[i]);
      } else {
        groups.push(currentGroup);
        currentGroup = [chunks[i]];
      }
    }
    groups.push(currentGroup);

    return groups;
  }, []);

  const items = useMemo(() => {
    const list: TerminalItem[] = [];

    if (trackedState) {
      // Add messages
      trackedState.messages.forEach(m =>
        list.push({ kind: 'message', data: m, timestamp: new Date(m.timestamp).getTime() })
      );

      // Add tools
      trackedState.tools.forEach(t =>
        list.push({ kind: 'tool', data: t, timestamp: new Date(t.timestamp).getTime() })
      );

      // Add grouped console chunks
      const chunkGroups = groupConsoleChunks(trackedState.consoleChunks);
      chunkGroups.forEach(group => {
        const firstChunk = group[0];
        list.push({ kind: 'console', data: group, timestamp: new Date(firstChunk.timestamp).getTime() });
      });

      // Add events (filter out message, tool, and node events to avoid clutter)
      // Node events like node.progress/node.started are operational and shouldn't appear in chat
      trackedState.events.forEach(e => {
        if (e.type.startsWith('message.') || e.type.startsWith('tool.') || e.type.startsWith('node.')) {
          return;
        }
        list.push({ kind: 'event', data: e, timestamp: new Date(e.timestamp).getTime() });
      });
    }

    // Add pending messages only if they don't already exist in trackedState
    // Match by content to avoid duplicates between optimistic updates and server events
    const realUserMessageContents = new Set(
      (trackedState?.messages || [])
        .filter(m => m.type === 'user')
        .map(m => m.content)
    );
    pendingMessages.forEach(m => {
      if (!realUserMessageContents.has(m.content)) {
        list.push({ kind: 'message', data: m, timestamp: new Date(m.timestamp).getTime(), isPending: true });
      }
    });

    return list.sort((a, b) => a.timestamp - b.timestamp);
  }, [trackedState, groupConsoleChunks, pendingMessages]);

  // Check if the last item is a user message (Thinking state)
  // Show spinner when waiting for a response, regardless of node status
  // This fixes the race condition where the first message appears before nodeStatus updates to 'running'
  const isThinking = useMemo(() => {
    if (items.length === 0) return false;

    // Find the last message in items (skip events/tools/console which may interleave)
    const lastMessage = [...items].reverse().find(item => item.kind === 'message');
    if (!lastMessage || lastMessage.kind !== 'message') return false;

    // Show thinking if the last message is from the user (waiting for assistant reply)
    const isLastUser = lastMessage.data.type === 'user';

    // Also check if there's a partial assistant message being streamed
    const hasPartialAssistant = items.some(
      item => item.kind === 'message' && item.data.type === 'assistant' && item.data.isPartial
    );

    return isLastUser && !hasPartialAssistant;
  }, [items]);

  // Auto-scroll with smart behavior - handles both new items and streaming content
  const prevItemsLength = useRef(0);
  const prevScrollHeight = useRef(0);
  const userScrolledUp = useRef(false);

  // Track if user manually scrolled up
  const handleScroll = useCallback(() => {
    if (!messagesRef.current) return;
    const el = messagesRef.current;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    userScrolledUp.current = !isNearBottom;
  }, []);

  // Get the last message content length to detect streaming updates
  const lastMessageContentLength = useMemo(() => {
    const messages = trackedState?.messages || [];
    const lastMsg = messages[messages.length - 1];
    return lastMsg?.content?.length || 0;
  }, [trackedState?.messages]);

  // Auto-scroll on new items, content changes, or thinking state
  useEffect(() => {
    if (!messagesRef.current) return;
    const el = messagesRef.current;

    const hasNewItems = items.length > prevItemsLength.current;
    const contentChanged = el.scrollHeight !== prevScrollHeight.current;
    // Also scroll if we started thinking
    const justStartedThinking = isThinking && (items.length === prevItemsLength.current);
    
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;

    // Scroll if: new items, content changed while near bottom, first render, or just started thinking
    if (hasNewItems || (contentChanged && isNearBottom) || prevItemsLength.current === 0 || justStartedThinking) {
      if (!userScrolledUp.current || hasNewItems || justStartedThinking) {
        el.scrollTop = el.scrollHeight;
      }
    }

    prevItemsLength.current = items.length;
    prevScrollHeight.current = el.scrollHeight;
  }, [items.length, lastMessageContentLength, isThinking]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Let Escape propagate so it can deselect the node
    if (e.key === 'Escape') return;

    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const content = inputValue.trim();
      if (content && onMessage) {
        // No optimistic update - server emits message.user event which will show the message
        onMessage(content);
        setInputValue('');
      }
    }
  };

  return (
    <div className="term-container">
      <div className="term-content" ref={messagesRef} onScroll={handleScroll}>
        {items.length === 0 && (
          <div className="term-empty">
            <div className="term-empty__icon" />
            <div className="term-empty__text">Waiting for events...</div>
          </div>
        )}

        {items.map((item, idx) => {
          if (item.kind === 'message') {
            return <MessageBlock key={item.data.id || `msg-${idx}`} msg={item.data} isPending={item.isPending} />;
          }

          if (item.kind === 'tool') {
            return <ToolBlock key={item.data.id || `tool-${idx}`} tool={item.data} />;
          }

          if (item.kind === 'console') {
            return <ConsoleBlock key={`console-${idx}`} chunks={item.data} />;
          }

          if (item.kind === 'event') {
            return <EventBlock key={item.data.id || `event-${idx}`} event={item.data} />;
          }

          return null;
        })}
        
         {isThinking && (
          <div className="term-spinner">
            <div className="term-spinner__icon" />
            <span>Thinking...</span>
          </div>
        )}
      </div>

      <div className={`term-input ${isInteractive ? 'term-input--visible' : ''}`}>
        <span className="term-input__prompt" />
        <input
          ref={inputRef}
          type="text"
          className="term-input__field"
          placeholder="Send a message..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!isInteractive}
        />
      </div>
    </div>
  );
}


// ----------------------------------------------------------------------------
// Stats Tab
// ----------------------------------------------------------------------------

function StatsTab({ node, artifacts = [] }: { node: Node; artifacts?: Artifact[] }) {
  const duration = node.durationMs
    ? node.durationMs < 1000
      ? `${node.durationMs}ms`
      : node.durationMs < 60000
        ? `${(node.durationMs / 1000).toFixed(1)}s`
        : `${Math.floor(node.durationMs / 60000)}m ${Math.round((node.durationMs % 60000) / 1000)}s`
    : node.startedAt
      ? 'Running...'
      : '-';

  return (
    <div className="vuhlp-node-window__stats-container">
      <div className="vuhlp-node-window__stat-group">
        <label>Status</label>
        <div className={`vuhlp-node-window__stat-value vuhlp-node-window__status--${node.status}`}>
          {node.status.toUpperCase()}
        </div>
      </div>

       <div className="vuhlp-node-window__stat-group">
        <label>Provider</label>
        <div className="vuhlp-node-window__stat-value">{node.providerId || 'Unknown'}</div>
      </div>

      <div className="vuhlp-node-window__stat-group">
        <label>Duration</label>
        <div className="vuhlp-node-window__stat-value">{duration}</div>
      </div>

      <div className="vuhlp-node-window__stat-divider" />

      <div className="vuhlp-node-window__stat-group">
        <label>Files Changed ({artifacts.length})</label>
        <div className="vuhlp-node-window__file-list">
          {artifacts.length === 0 ? (
            <span className="vuhlp-node-window__empty-text">No artifacts produced</span>
          ) : (
            artifacts.map(art => (
              <div key={art.id} className="vuhlp-node-window__file-item">
                <span className="vuhlp-node-window__file-icon" />
                <span className="vuhlp-node-window__file-name" title={art.path}>{art.name}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Main Component
// ----------------------------------------------------------------------------

export function NodeWindowTabs(props: NodeWindowTabsProps) {
  const [activeTab, setActiveTab] = useState<TabType>('terminal');

  // Calculate counts for badges
  const msgCount = props.trackedState?.messages.length || 0;
  const toolCount = props.trackedState?.tools.length || 0;

  return (
    <>
      <div className="vuhlp-node-window__tabs">
        <button
          className={`vuhlp-node-window__tab ${activeTab === 'terminal' ? 'vuhlp-node-window__tab--active' : ''}`}
          onClick={(e) => { e.stopPropagation(); setActiveTab('terminal'); }}
        >
          Terminal
          {(msgCount > 0 || toolCount > 0) && (
            <span className="vuhlp-node-window__tab-count">{msgCount + toolCount}</span>
          )}
        </button>
        <button
          className={`vuhlp-node-window__tab ${activeTab === 'stats' ? 'vuhlp-node-window__tab--active' : ''}`}
          onClick={(e) => { e.stopPropagation(); setActiveTab('stats'); }}
        >
          Stats
        </button>
      </div>

      <div className="vuhlp-node-window__content">
        {activeTab === 'terminal' ? (
          <TerminalTab
            trackedState={props.trackedState}
            onMessage={props.onMessage}
            isInteractive={props.isInteractive}
          />
        ) : (
          <StatsTab
            node={props.node}
            artifacts={props.artifacts}
          />
        )}
      </div>
    </>
  );
}
