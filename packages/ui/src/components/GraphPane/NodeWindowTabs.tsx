import { useState } from 'react';
import type { NodeTrackedState, MessageEvent, ToolEvent, GenericEvent } from '../../types';

type TabType = 'messages' | 'activity' | 'tools';

interface NodeWindowTabsProps {
  trackedState: NodeTrackedState | undefined;
}

function formatTime(isoString: string): string {
  try {
    return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + '…';
}

function MessagesContent({ messages }: { messages: MessageEvent[] }) {
  // Show last 3 messages
  const recentMessages = messages.slice(-3);

  if (recentMessages.length === 0) {
    return <div className="vuhlp-node-window__empty">No messages yet</div>;
  }

  return (
    <div className="vuhlp-node-window__messages">
      {recentMessages.map((msg) => (
        <div
          key={msg.id}
          className={`vuhlp-node-window__message vuhlp-node-window__message--${msg.type}`}
        >
          <span className="vuhlp-node-window__message-type">{msg.type}</span>
          <span className="vuhlp-node-window__message-content">
            {truncate(msg.content, 80)}
          </span>
          {msg.isPartial && <span className="vuhlp-node-window__typing">▍</span>}
        </div>
      ))}
    </div>
  );
}

function ActivityContent({ events }: { events: GenericEvent[] }) {
  // Show last 5 events
  const recentEvents = events.slice(-5);

  if (recentEvents.length === 0) {
    return <div className="vuhlp-node-window__empty">No activity yet</div>;
  }

  return (
    <div className="vuhlp-node-window__activity">
      {recentEvents.map((event) => (
        <div key={event.id} className="vuhlp-node-window__event">
          <span className="vuhlp-node-window__event-time">{formatTime(event.timestamp)}</span>
          <span className="vuhlp-node-window__event-type">{event.type.split('.').pop()}</span>
          <span className="vuhlp-node-window__event-message">{truncate(event.message, 40)}</span>
        </div>
      ))}
    </div>
  );
}

function ToolsContent({ tools }: { tools: ToolEvent[] }) {
  // Show last 4 tools
  const recentTools = tools.slice(-4);

  if (recentTools.length === 0) {
    return <div className="vuhlp-node-window__empty">No tool calls yet</div>;
  }

  return (
    <div className="vuhlp-node-window__tools">
      {recentTools.map((tool) => (
        <div key={tool.id} className="vuhlp-node-window__tool">
          <span className={`vuhlp-node-window__tool-status vuhlp-node-window__tool-status--${tool.status}`}>
            {tool.status === 'started' ? '●' : tool.status === 'completed' ? '✓' : tool.status === 'failed' ? '✗' : '○'}
          </span>
          <span className="vuhlp-node-window__tool-name">{tool.name}</span>
          {tool.durationMs !== undefined && (
            <span className="vuhlp-node-window__tool-duration">{tool.durationMs}ms</span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Mini-tab component for node window content.
 * Shows Messages, Activity, or Tools tabs.
 */
export function NodeWindowTabs({ trackedState }: NodeWindowTabsProps) {
  const [activeTab, setActiveTab] = useState<TabType>('messages');

  const messages = trackedState?.messages || [];
  const events = trackedState?.events || [];
  const tools = trackedState?.tools || [];

  return (
    <>
      <div className="vuhlp-node-window__tabs">
        <button
          className={`vuhlp-node-window__tab ${activeTab === 'messages' ? 'vuhlp-node-window__tab--active' : ''}`}
          onClick={() => setActiveTab('messages')}
        >
          Messages
          {messages.length > 0 && (
            <span className="vuhlp-node-window__tab-count">{messages.length}</span>
          )}
        </button>
        <button
          className={`vuhlp-node-window__tab ${activeTab === 'activity' ? 'vuhlp-node-window__tab--active' : ''}`}
          onClick={() => setActiveTab('activity')}
        >
          Activity
          {events.length > 0 && (
            <span className="vuhlp-node-window__tab-count">{events.length}</span>
          )}
        </button>
        <button
          className={`vuhlp-node-window__tab ${activeTab === 'tools' ? 'vuhlp-node-window__tab--active' : ''}`}
          onClick={() => setActiveTab('tools')}
        >
          Tools
          {tools.length > 0 && (
            <span className="vuhlp-node-window__tab-count">{tools.length}</span>
          )}
        </button>
      </div>

      <div className="vuhlp-node-window__content">
        {activeTab === 'messages' && <MessagesContent messages={messages} />}
        {activeTab === 'activity' && <ActivityContent events={events} />}
        {activeTab === 'tools' && <ToolsContent tools={tools} />}
      </div>
    </>
  );
}
