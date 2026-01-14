import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

// Custom components for rendering markdown elements
const markdownComponents: Components = {
  // Render paragraphs without extra margins for inline-ish content
  p: ({ children }) => <span className="md-paragraph">{children}</span>,
  // Code blocks (inline)
  code: ({ className, children }) => {
    const isInline = !className;
    if (isInline) {
      return <code className="md-code-inline">{children}</code>;
    }
    return <code className={className}>{children}</code>;
  },
  // Pre blocks for fenced code
  pre: ({ children }) => <pre className="md-code-block">{children}</pre>,
  // Lists
  ul: ({ children }) => <ul className="md-list md-list--ul">{children}</ul>,
  ol: ({ children }) => <ol className="md-list md-list--ol">{children}</ol>,
  li: ({ children }) => <li className="md-list-item">{children}</li>,
  // Headings
  h1: ({ children }) => <h1 className="md-heading md-h1">{children}</h1>,
  h2: ({ children }) => <h2 className="md-heading md-h2">{children}</h2>,
  h3: ({ children }) => <h3 className="md-heading md-h3">{children}</h3>,
  h4: ({ children }) => <h4 className="md-heading md-h4">{children}</h4>,
  // Links
  a: ({ href, children }) => (
    <a href={href} className="md-link" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // Emphasis
  strong: ({ children }) => <strong className="md-strong">{children}</strong>,
  em: ({ children }) => <em className="md-em">{children}</em>,
  // Blockquotes
  blockquote: ({ children }) => <blockquote className="md-blockquote">{children}</blockquote>,
  // Horizontal rule
  hr: () => <hr className="md-hr" />,
};

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div className={`md-content ${className || ''}`}>
      <ReactMarkdown components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
