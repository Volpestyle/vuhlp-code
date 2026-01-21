/**
 * Fullscreen Chat component
 * Shows a single node's chat in fullscreen with real-time streaming
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { NodeState } from '@vuhlp/contracts';
import {
  buildTimeline,
  isHandoffTimelineItem,
  buildReceiveHandoffToolEvent,
} from '@vuhlp/shared';
import { useRunStore, type ChatMessage, type ToolEvent } from '../stores/runStore';
import { postChat } from '../lib/api';
import { StatusBadge } from './StatusBadge';
import { ProviderBadge } from './ProviderBadge';
import { TimelineItem } from './TimelineItem';
import { ThinkingSpinner } from '@vuhlp/spinners';
import { SendDiagonal } from 'iconoir-react';
import { useChatAutoScroll } from '../hooks/useChatAutoScroll';
import './FullscreenChat.css';

type ChatVariant = 'full' | 'mid';
type ChatFilter = 'all' | 'handoffs';
const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];



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
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all');
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const runId = useRunStore((s) => s.run?.id);
  const addChatMessage = useRunStore((s) => s.addChatMessage);
  const updateChatMessageStatus = useRunStore((s) => s.updateChatMessageStatus);
  const messages = useRunStore((s) => s.chatMessages[node.id]);
  const recentHandoffs = useRunStore((s) => s.recentHandoffs);
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
  const incomingHandoffs = useMemo(
    () => recentHandoffs.filter((handoff) => handoff.toNodeId === node.id),
    [recentHandoffs, node.id]
  );
  const incomingHandoffTools = useMemo(
    () => incomingHandoffs.map((handoff) => buildReceiveHandoffToolEvent(handoff)),
    [incomingHandoffs]
  );
  const combinedToolEvents = useMemo(
    () => [...nodeToolEvents, ...incomingHandoffTools],
    [nodeToolEvents, incomingHandoffTools]
  );
  const timeline = useMemo(
    () => buildTimeline(safeMessages, combinedToolEvents, nodeStatusEvents),
    [safeMessages, combinedToolEvents, nodeStatusEvents]
  );
  const handoffCount = useMemo(() => timeline.filter(isHandoffTimelineItem).length, [timeline]);
  const filteredTimeline = useMemo(
    () => (chatFilter === 'handoffs' ? timeline.filter(isHandoffTimelineItem) : timeline),
    [chatFilter, timeline]
  );
  const toolTimelineItems = useMemo(
    () => filteredTimeline.filter((item): item is { type: 'tool'; data: ToolEvent } => item.type === 'tool'),
    [filteredTimeline]
  );
  const showToolFallback = chatFilter === 'all' && toolTimelineItems.length === 0 && combinedToolEvents.length > 0;
  const fallbackToolEvents = useMemo(() => {
    if (!showToolFallback) {
      return [];
    }
    return [...combinedToolEvents].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }, [combinedToolEvents, showToolFallback]);

  const isStreamingMessage = useMemo(() => {
    const lastMessage = [...timeline].reverse().find((item) => item.type === 'message');
    return Boolean(
      lastMessage?.type === 'message' && (lastMessage.data.streaming || lastMessage.data.thinkingStreaming)
    );
  }, [timeline]);
  const autoScrollKey = useMemo(
    () => `${node.status}-${chatFilter}-${isStreamingMessage ? '1' : '0'}`,
    [node.status, chatFilter, isStreamingMessage]
  );
  const showInput = interactive && variant === 'full';

  useChatAutoScroll({ scrollRef: messagesScrollRef, timeline: filteredTimeline, resetKey: node.id, updateKey: autoScrollKey });

  // Simulated streaming indicator based on node connection state
  useEffect(() => {
    setIsStreaming(node.connection?.streaming ?? false);
  }, [node.connection?.streaming]);

  useEffect(() => {
    if (!showToolFallback) {
      return;
    }
    console.warn('[fullscreen-chat] tool events missing from timeline', {
      nodeId: node.id,
      toolEventCount: combinedToolEvents.length,
      timelineCount: filteredTimeline.length,
    });
  }, [combinedToolEvents.length, filteredTimeline.length, node.id, showToolFallback]);

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
                <ThinkingSpinner size="sm" variant="assemble" color="#d4cef0" />
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
        {timeline.length > 0 && (
          <div className="fullscreen-chat__filters">
            <button
              className={`fullscreen-chat__filter-button ${chatFilter === 'all' ? 'fullscreen-chat__filter-button--active' : ''}`}
              type="button"
              onClick={() => setChatFilter('all')}
            >
              All
              <span className="fullscreen-chat__filter-count">{timeline.length}</span>
            </button>
            <button
              className={`fullscreen-chat__filter-button ${chatFilter === 'handoffs' ? 'fullscreen-chat__filter-button--active' : ''}`}
              type="button"
              onClick={() => setChatFilter('handoffs')}
            >
              Handoffs
              <span className="fullscreen-chat__filter-count">{handoffCount}</span>
            </button>
          </div>
        )}
        {filteredTimeline.length === 0 && node.status !== 'running' && import.meta.env.VITE_TEST_CUBE_SPINNER !== 'true' ? (
          <div className="fullscreen-chat__empty">
            <p className="fullscreen-chat__empty-text">
              {chatFilter === 'handoffs' ? 'No handoffs yet' : `Start a conversation with ${node.label}`}
            </p>
            <p className="fullscreen-chat__empty-hint">
              Messages will appear here in real-time
            </p>
          </div>
        ) : (
          <>
            {filteredTimeline.map((item) => (
              <TimelineItem
                key={`${item.type}-${item.data.id}`}
                item={item}
                onRetry={handleRetry}
              />
            ))}
            {(() => {
              if ((node.status === 'running' && !isStreamingMessage) || import.meta.env.VITE_TEST_CUBE_SPINNER === 'true') {
                return (
                  <div className="timeline-message timeline-message--assistant timeline-message--thinking">
                    <div className="timeline-message__header">
                      <span className="timeline-message__role">assistant</span>
                      <div className="timeline-message__meta">
                        <span className="timeline-message__streaming timeline-message__streaming--thinking">
                          <ThinkingSpinner size="sm" variant="assemble" color="#7aedc4" />
                          thinking
                        </span>
                      </div>
                    </div>
                    <div className="timeline-message__content">
                      <ThinkingSpinner size="lg" variant="assemble" color="#7aedc4" />
                    </div>
                  </div>
                );
              }
              return null;
            })()}
          </>
        )}
        {showToolFallback && (
          <div className="fullscreen-chat__tool-fallback">
            <span className="fullscreen-chat__tool-fallback-label">Tools</span>
            {fallbackToolEvents.map((event) => (
              <TimelineItem key={`tool-fallback-${event.id}`} item={{ type: 'tool', data: event }} />
            ))}
          </div>
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
