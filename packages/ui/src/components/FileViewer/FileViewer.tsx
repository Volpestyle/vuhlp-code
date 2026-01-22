import './FileViewer.css';

export interface FileViewerProps {
  filePath: string;
  content: string;
}

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    py: 'python',
    go: 'go',
    rs: 'rust',
    sql: 'sql',
    txt: 'text',
    xml: 'xml',
    svg: 'xml',
  };

  return languageMap[ext] || 'text';
}

export function FileViewer({ filePath, content }: FileViewerProps) {
  const lines = content.split('\n');
  const fileName = filePath.split('/').pop() || filePath;
  const language = getLanguage(filePath);

  return (
    <div className="vuhlp-file-viewer">
      <div className="vuhlp-file-viewer__header">
        <span className="vuhlp-file-viewer__filename" title={filePath}>
          {fileName}
        </span>
        <span className="vuhlp-file-viewer__language">{language}</span>
        <span className="vuhlp-file-viewer__lines">{lines.length} lines</span>
      </div>
      <div className="vuhlp-file-viewer__content">
        <div className="vuhlp-file-viewer__gutter">
          {lines.map((_, i) => (
            <div key={i} className="vuhlp-file-viewer__line-number">
              {i + 1}
            </div>
          ))}
        </div>
        <pre className="vuhlp-file-viewer__code">
          <code>{content}</code>
        </pre>
      </div>
    </div>
  );
}
