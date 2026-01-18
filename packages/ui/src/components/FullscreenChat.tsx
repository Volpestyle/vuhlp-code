/**
 * Fullscreen Chat component
 * Shows a single node's chat in fullscreen with real-time streaming
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { NodeState } from '@vuhlp/contracts';
import { useRunStore, type ChatMessage, type ToolEvent, type TurnStatusEvent, type TimelineEvent } from '../stores/runStore';
import { postChat } from '../lib/api';
import { StatusBadge } from './StatusBadge';
import { ProviderBadge } from './ProviderBadge';
import { TimelineItem } from './TimelineItem';
import { ThinkingSpinner } from './ThinkingSpinner';
import { SendDiagonal } from 'iconoir-react';
import { useChatAutoScroll } from '../hooks/useChatAutoScroll';
import './FullscreenChat.css';

type ChatVariant = 'full' | 'mid';
const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];

const buildNodeTimeline = (
  messages: ChatMessage[],
  tools: ToolEvent[],
  statuses: TurnStatusEvent[]
): TimelineEvent[] => {
  const timeline: TimelineEvent[] = [
    ...messages.map((message) => ({ type: 'message' as const, data: message })),
    ...tools.map((tool) => ({ type: 'tool' as const, data: tool })),
    ...statuses.map((status) => ({ type: 'status' as const, data: status })),
  ];

  return timeline.sort((a, b) => {
    const timeA = new Date(a.type === 'message' ? a.data.createdAt : a.data.timestamp).getTime();
    const timeB = new Date(b.type === 'message' ? b.data.createdAt : b.data.timestamp).getTime();
    return timeA - timeB;
  });
};

interface FullscreenChatProps {
  node: NodeState;
  variant?: ChatVariant;
  interactive?: boolean;
}

export function FullscreenChat({
  node,
  variant = 'full',
  interactive = true,
}: FullscreenChatProps) {
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const runId = useRunStore((s) => s.run?.id);
  const addChatMessage = useRunStore((s) => s.addChatMessage);
  const updateChatMessageStatus = useRunStore((s) => s.updateChatMessageStatus);
  const messages = useRunStore((s) => s.chatMessages[node.id]);
  const toolEvents = useRunStore((s) => s.toolEvents);
  const turnStatusEvents = useRunStore((s) => s.turnStatusEvents);
  const wsConnectionStatus = useRunStore((s) => s.ui.wsConnectionStatus);
  const nodeToolEvents = useMemo(
    () => toolEvents.filter((event) => event.nodeId === node.id),
    [toolEvents, node.id]
  );
  const nodeStatusEvents = useMemo(
    () => turnStatusEvents.filter((event) => event.nodeId === node.id),
    [turnStatusEvents, node.id]
  );
  const safeMessages = messages ?? EMPTY_CHAT_MESSAGES;
  const timeline = useMemo(
    () => buildNodeTimeline(safeMessages, nodeToolEvents, nodeStatusEvents),
    [safeMessages, nodeToolEvents, nodeStatusEvents]
  );
  const showInput = interactive && variant === 'full';

  useChatAutoScroll({ scrollRef: messagesScrollRef, timeline, resetKey: node.id });

  // Simulated streaming indicator based on node connection state
  useEffect(() => {
    setIsStreaming(node.connection?.streaming ?? false);
  }, [node.connection?.streaming]);

  const sendMessage = useCallback(
    async (messageId: string, content: string) => {
      if (!runId) {
        updateChatMessageStatus(node.id, messageId, {
          pending: false,
          sendError: 'No active run',
        });
        return;
      }
      try {
        await postChat(runId, node.id, content, true);
        updateChatMessageStatus(node.id, messageId, { pending: false });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to send message';
        console.error('[fullscreen-chat] failed to send', error);
        updateChatMessageStatus(node.id, messageId, {
          pending: false,
          sendError: errorMessage,
        });
      }
    },
    [runId, node.id, updateChatMessageStatus]
  );

  const handleSend = () => {
    if (!input.trim()) return;

    const now = new Date().toISOString();
    const messageId = `local-${crypto.randomUUID()}`;
    const newMessage: ChatMessage = {
      id: messageId,
      nodeId: node.id,
      role: 'user',
      content: input,
      createdAt: now,
      pending: true,
    };
    addChatMessage(newMessage);
    setInput('');
    void sendMessage(messageId, input);
  };

  const handleRetry = useCallback(
    (messageId: string, content: string) => {
      updateChatMessageStatus(node.id, messageId, { pending: true, sendError: undefined });
      void sendMessage(messageId, content);
    },
    [node.id, updateChatMessageStatus, sendMessage]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={`fullscreen-chat fullscreen-chat--${variant}`} data-graph-zoom-block>
      {/* Header */}
      <header className="fullscreen-chat__header">
        <div className="fullscreen-chat__node-info">
          <h1 className="fullscreen-chat__title">{node.label}</h1>
          <div className="fullscreen-chat__meta">
            <ProviderBadge provider={node.provider} />
            <StatusBadge status={node.status} />
            {isStreaming && (
              <span className="fullscreen-chat__streaming">
                <ThinkingSpinner size="sm" />
                Streaming
              </span>
            )}
            <span
              className={`fullscreen-chat__connection fullscreen-chat__connection--${wsConnectionStatus}`}
              title={
                wsConnectionStatus === 'connected'
                  ? 'Connected'
                  : wsConnectionStatus === 'connecting'
                    ? 'Connecting...'
                    : wsConnectionStatus === 'error'
                      ? 'Connection error'
                      : 'Disconnected'
              }
            >
              <span className="fullscreen-chat__connection-dot" />
              {wsConnectionStatus !== 'connected' && (
                <span className="fullscreen-chat__connection-text">
                  {wsConnectionStatus === 'connecting'
                    ? 'Connecting...'
                    : wsConnectionStatus === 'error'
                      ? 'Connection error'
                      : 'Disconnected'}
                </span>
              )}
            </span>
          </div>
        </div>
        <div className="fullscreen-chat__summary">
          {node.summary || 'Waiting for activity...'}
        </div>
      </header>

      {/* Messages */}
      <div className="fullscreen-chat__messages" ref={messagesScrollRef}>
        {timeline.length === 0 && node.status !== 'running' ? (
          <div className="fullscreen-chat__empty">
            <p className="fullscreen-chat__empty-text">
              Start a conversation with {node.label}
            </p>
            <p className="fullscreen-chat__empty-hint">
              Messages will appear here in real-time
            </p>
          </div>
        ) : (
          <>
            {timeline.map((item) => (
              <TimelineItem
                key={`${item.type}-${item.data.id}`}
                item={item}
                onRetry={handleRetry}
              />
            ))}
            {(() => {
              const lastItem = timeline[timeline.length - 1];
              const isStreamingMessage = lastItem?.type === 'message' && (lastItem.data.streaming || lastItem.data.thinkingStreaming);

              if (node.status === 'running' && !isStreamingMessage) {
                return (
                  <div className="timeline-message timeline-message--assistant timeline-message--streaming">
                    <div className="timeline-message__header">
                      <span className="timeline-message__role">assistant</span>
                      <div className="timeline-message__meta">
                        <span className="timeline-message__streaming">
                          <ThinkingSpinner size="sm" />
                          thinking
                        </span>
                      </div>
                    </div>
                    <div className="timeline-message__content">
                      <ThinkingSpinner size="lg" />
                    </div>
                  </div>
                );
              }
              return null;
            })()}
          </>
        )}
      </div>

      {/* Input */}
      {showInput && (
        <footer className="fullscreen-chat__footer">
          <div className="fullscreen-chat__input-wrapper">
            <textarea
              className="fullscreen-chat__input"
              placeholder={`Message ${node.label}...`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            <button
              className="fullscreen-chat__send"
              onClick={handleSend}
              disabled={!input.trim()}
              title="Send"
            >
              <SendDiagonal width={16} height={16} />
            </button>
          </div>
          <div className="fullscreen-chat__hints">
            <span>Press <kbd>Enter</kbd> to send</span>
            <span>Press <kbd>esc</kbd> to zoom out</span>
          </div>
        </footer>
      )}
    </div>
  );
}
