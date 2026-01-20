import type { ToolCall, ToolCompletedEvent } from '@vuhlp/contracts';
import './JsonView.css';

interface JsonViewProps {
  data: ToolCall['args'] | ToolCompletedEvent['result'];
}

const formatJson = (data: ToolCall['args'] | ToolCompletedEvent['result']): { content: string; error?: string } => {
  try {
    const serialized = JSON.stringify(data, null, 2);
    if (typeof serialized === 'string') {
      return { content: serialized };
    }
    return { content: 'null' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to format JSON';
    return { content: 'null', error: message };
  }
};

export function JsonView({ data }: JsonViewProps) {
  const { content, error } = formatJson(data);
  if (error) {
    console.error('[json-view] failed to format JSON', { error, data });
  }
  return (
    <div className={`json-view ${error ? 'json-view--error' : ''}`}>
      {error && <span className="json-view__error">Unable to format JSON. See console for details.</span>}
      <pre className="json-view__code">{content}</pre>
    </div>
  );
}
