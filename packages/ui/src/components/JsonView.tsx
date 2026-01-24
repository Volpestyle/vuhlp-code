import type { ToolCall, ToolCompletedEvent } from '@vuhlp/contracts';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import './JsonView.css';

interface JsonViewProps {
  data: ToolCall['args'] | ToolCompletedEvent['result'];
}

const customJsonTheme = {
  ...oneDark,
  'pre[class*="language-"]': {
    ...oneDark['pre[class*="language-"]'],
    margin: 0,
    padding: 'var(--space-2)',
    background: 'var(--color-bg-secondary)',
    fontSize: '11px',
    lineHeight: '1.5',
    borderRadius: 'var(--radius-sm)',
  },
  'code[class*="language-"]': {
    ...oneDark['code[class*="language-"]'],
    background: 'transparent',
    fontSize: '11px',
    fontFamily: 'var(--font-mono)',
  },
};

const formatJson = (data: ToolCall['args'] | ToolCompletedEvent['result']): { content: string; error?: string } => {
  try {
    const serialized = JSON.stringify(data, null, 2);
    if (typeof serialized === 'string') {
      return { content: serialized };
    }
    return { content: 'null' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to format JSON';
    console.error('[json-view] formatJson failed', { message, data });
    return { content: 'null', error: message };
  }
};

export function JsonView({ data }: JsonViewProps) {
  const { content, error } = formatJson(data);

  if (error) {
    return (
      <div className="json-view json-view--error">
        <span className="json-view__error">Unable to format JSON. See console for details.</span>
        <pre className="json-view__code">{content}</pre>
      </div>
    );
  }

  return (
    <div className="json-view">
      <SyntaxHighlighter
        language="json"
        style={customJsonTheme}
        customStyle={{
          margin: 0,
          padding: 'var(--space-2)',
          background: 'var(--color-bg-secondary)',
          borderRadius: 'var(--radius-sm)',
          fontSize: '11px',
          lineHeight: '1.5',
        }}
        codeTagProps={{
          style: {
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
          },
        }}
      >
        {content}
      </SyntaxHighlighter>
    </div>
  );
}
