
import { useState } from 'react';
import { useRunStore, type ChatMessage, type ToolEvent, type TurnStatusEvent } from '../stores/runStore';
import { NavArrowDown, NavArrowRight, Wrench, Brain, Refresh, InfoCircle } from 'iconoir-react';
import { MarkdownContent } from './MarkdownContent';
import { JsonView } from './JsonView';
import { ThinkingSpinner } from '@vuhlp/spinners';
import './TimelineItem.css';

interface TimelineItemProps {
  item:
    | { type: 'message'; data: ChatMessage }
    | { type: 'tool'; data: ToolEvent }
    | { type: 'status'; data: TurnStatusEvent };
  onRetry?: (messageId: string, content: string) => void;
}

function StatusItem({ event }: { event: TurnStatusEvent }) {
  const label = event.detail?.trim() || event.status.replace(/_/g, ' ');
  return (
    <div className="timeline-status">
      <div className="timeline-status__meta">
        <span className="timeline-status__icon">
          <InfoCircle width={14} height={14} />
        </span>
        <span className="timeline-status__label">{label}</span>
      </div>
      <span className="timeline-status__time">
        {new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false })}
      </span>
    </div>
  );
}

export function TimelineItem({ item, onRetry }: TimelineItemProps) {
  if (item.type === 'message') {
    return <MessageItem message={item.data} onRetry={onRetry} />;
  }
  if (item.type === 'status') {
    return <StatusItem event={item.data} />;
  }
  return <ToolItem event={item.data} />;
}

interface MessageItemProps {
  message: ChatMessage;
  onRetry?: (messageId: string, content: string) => void;
}

function MessageItem({ message, onRetry }: MessageItemProps) {
  const hasThinking = message.thinking && message.thinking.length > 0;
  const isThinkingActive = message.thinkingStreaming || hasThinking;
  // Auto-expand when actively thinking, allow manual toggle otherwise
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const thinkingExpanded = manualExpanded ?? message.thinkingStreaming ?? false;

  const isPending = message.pending;
  const hasError = Boolean(message.sendError);

  const handleRetryClick = () => {
    if (onRetry && hasError) {
      onRetry(message.id, message.content);
    }
  };

  return (
    <div
      className={`timeline-message timeline-message--${message.role} ${
        message.streaming ? 'timeline-message--streaming' : ''
      } ${message.thinkingStreaming ? 'timeline-message--thinking' : ''} ${
        isPending ? 'timeline-message--pending' : ''
      } ${hasError ? 'timeline-message--error' : ''}`}
    >
      <div className="timeline-message__header">
        <span className="timeline-message__role">{message.role}</span>
        <div className="timeline-message__meta">
          {isPending && (
            <span className="timeline-message__pending">
              <span className="timeline-message__pending-dot" />
              Sending...
            </span>
          )}
          {hasError && (
            <span className="timeline-message__error-badge" title={message.sendError}>
              Failed
            </span>
          )}
          {message.streaming && !message.thinkingStreaming && (
            <span className="timeline-message__streaming">
              <ThinkingSpinner size="sm" variant="assemble" color="#d4cef0" />
              streaming
            </span>
          )}
          {message.thinkingStreaming && (
            <span className="timeline-message__streaming timeline-message__streaming--thinking">
              <ThinkingSpinner size="sm" variant="assemble" color="#7aedc4" />
              thinking
            </span>
          )}
          {message.status === 'interrupted' && (
            <span className="timeline-message__status timeline-message__status--interrupted">
              interrupted
            </span>
          )}
          <span className="timeline-message__time">
            {new Date(message.createdAt).toLocaleTimeString('en-US', { hour12: false })}
          </span>
        </div>
      </div>

      {isThinkingActive && (
        <div className={`timeline-message__thinking ${message.thinkingStreaming ? 'timeline-message__thinking--active' : ''}`}>
          <button
            className="timeline-message__thinking-toggle"
            onClick={() => setManualExpanded(manualExpanded === null ? !thinkingExpanded : !manualExpanded)}
            type="button"
          >
            {thinkingExpanded ? (
              <NavArrowDown width={14} height={14} />
            ) : (
              <NavArrowRight width={14} height={14} />
            )}
            <Brain width={14} height={14} />
            <span>Thinking</span>
            {message.thinkingStreaming && (
              <span className="timeline-message__streaming-dot" />
            )}
          </button>
          {thinkingExpanded && (
            <div className="timeline-message__thinking-content">
              <MarkdownContent content={message.thinking ?? ''} streaming={message.thinkingStreaming} />
            </div>
          )}
        </div>
      )}

      <div className="timeline-message__content">
        {message.role === 'assistant' ? (
          <MarkdownContent content={message.content} streaming={message.streaming && !message.thinkingStreaming} />
        ) : (
          message.content
        )}
      </div>

      {hasError && onRetry && (
        <div className="timeline-message__error-actions">
          <button
            className="timeline-message__retry-button"
            onClick={handleRetryClick}
            type="button"
          >
            <Refresh width={14} height={14} />
            <span>Retry</span>
          </button>
          <span className="timeline-message__error-text" title={message.sendError}>
            {message.sendError}
          </span>
        </div>
      )}
    </div>
  );
}

function ToolItem({ event }: { event: ToolEvent }) {
  const [expanded, setExpanded] = useState(false);
  const run = useRunStore((s) => s.run);
  const node = run?.nodes[event.nodeId];
  const isCompleted = event.status === 'completed' || event.status === 'failed';
  const hasError = event.status === 'failed' || event.error;

  return (
    <div className={`timeline-tool timeline-tool--${event.status}`}>
      <button
        className="timeline-tool__header"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <div className="timeline-tool__header-content">
          {node && (
            <div className="timeline-tool__meta-row">
              <span className="timeline-tool__node-label">{node.label}</span>
            </div>
          )}
          <div className="timeline-tool__main-row">
            <div className="timeline-tool__title-group">
              {expanded ? (
                <NavArrowDown width={14} height={14} />
              ) : (
                <NavArrowRight width={14} height={14} />
              )}
              <span className="timeline-tool__icon">
                <Wrench width={14} height={14} />
              </span>
              <span className="timeline-tool__name ms-1">{event.tool.name}</span>
              <span className={`timeline-tool__status timeline-tool__status--${event.status}`}>
                {event.status}
              </span>
            </div>
            <span className="timeline-tool__time">
              {new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false })}
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="timeline-tool__body">
          <div className="timeline-tool__section">
            <span className="timeline-tool__section-label">Arguments</span>
            <JsonView data={event.tool.args} />
          </div>

          {hasError && event.error && (
             <div className="timeline-tool__section">
              <span className="timeline-tool__section-label timeline-tool__section-label--error">Error</span>
              <pre className="timeline-tool__code timeline-tool__code--error">
                {event.error.message}
              </pre>
            </div>
          )}

          {isCompleted && event.result && (
            <div className="timeline-tool__section">
              <span className="timeline-tool__section-label">Result</span>
              <JsonView data={event.result} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
