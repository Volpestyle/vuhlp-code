import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Components } from 'react-markdown';
import './MarkdownContent.css';

interface MarkdownContentProps {
  content: string;
  streaming?: boolean;
}

const customCodeTheme = {
  ...oneDark,
  'pre[class*="language-"]': {
    ...oneDark['pre[class*="language-"]'],
    margin: 0,
    padding: 'var(--space-3)',
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

export function MarkdownContent({ content, streaming }: MarkdownContentProps) {
  const components: Components = {
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className ?? '');
      const isInline = !match && !className;
      const codeString = String(children).replace(/\n$/, '');

      if (isInline) {
        return (
          <code className="md-inline-code" {...props}>
            {children}
          </code>
        );
      }

      return (
        <SyntaxHighlighter
          style={customCodeTheme}
          language={match?.[1] ?? 'text'}
          PreTag="div"
          customStyle={{
            margin: 0,
            padding: 'var(--space-3)',
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
          {codeString}
        </SyntaxHighlighter>
      );
    },
    a({ children, href, ...props }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      );
    },
  };

  return (
    <div className={`md-content ${streaming ? 'md-content--streaming' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
