/**
 * Fullscreen Chat component
 * Shows a single node's chat in fullscreen with real-time streaming
 */

import { useState, useRef, useEffect } from 'react';
import type { NodeState } from '@vuhlp/contracts';
import { useRunStore, type ChatMessage } from '../stores/runStore';
import { postChat } from '../lib/api';
import { StatusBadge } from './StatusBadge';
import { ProviderBadge } from './ProviderBadge';
import { SendDiagonal } from 'iconoir-react';
import './FullscreenChat.css';

type ChatVariant = 'full' | 'mid';

const EMPTY_MESSAGES: ChatMessage[] = [];

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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const runId = useRunStore((s) => s.run?.id);
  const addChatMessage = useRunStore((s) => s.addChatMessage);
  const messages = useRunStore((s) => s.chatMessages[node.id] ?? EMPTY_MESSAGES);
  const showInput = interactive && variant === 'full';

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Simulated streaming indicator based on node connection state
  useEffect(() => {
    setIsStreaming(node.connection?.streaming ?? false);
  }, [node.connection?.streaming]);

  const handleSend = () => {
    if (!input.trim()) return;

    const now = new Date().toISOString();
    const newMessage: ChatMessage = {
      id: `local-${crypto.randomUUID()}`,
      nodeId: node.id,
      role: 'user',
      content: input,
      createdAt: now,
    };
    addChatMessage(newMessage);
    setInput('');

    if (runId) {
      void postChat(runId, node.id, input, true).catch((error) => {
        console.error('[fullscreen-chat] failed to send', error);
      });
    } else {
      console.warn('[fullscreen-chat] cannot send message without active run');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
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
                <span className="fullscreen-chat__streaming-dot" />
                Streaming
              </span>
            )}
          </div>
        </div>
        <div className="fullscreen-chat__summary">
          {node.summary || 'Waiting for activity...'}
        </div>
      </header>

      {/* Messages */}
      <div className="fullscreen-chat__messages">
        {messages.length === 0 ? (
          <div className="fullscreen-chat__empty">
            <p className="fullscreen-chat__empty-text">
              Start a conversation with {node.label}
            </p>
            <p className="fullscreen-chat__empty-hint">
              Messages will appear here in real-time
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`fullscreen-chat__message fullscreen-chat__message--${msg.role}`}
            >
              <div className="fullscreen-chat__message-header">
                <span className="fullscreen-chat__message-role">{msg.role}</span>
                <span className="fullscreen-chat__message-time">
                  {new Date(msg.createdAt).toLocaleTimeString('en-US', { hour12: false })}
                </span>
              </div>
              <div className="fullscreen-chat__message-content">
                {msg.content}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
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
