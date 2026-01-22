import { useState, useEffect, useCallback } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFolderOpen } from '@fortawesome/free-solid-svg-icons';
import type { FsResponse, FsEntry } from '../../types';
import './FileExplorer.css';

export interface FileExplorerProps {
  repoPath: string | null;
  onFetchFs: (path: string, includeFiles?: boolean) => Promise<FsResponse>;
  onOpenFile: (path: string) => void;
}

interface TreeNode extends FsEntry {
  children?: TreeNode[];
  loading?: boolean;
  expanded?: boolean;
}

function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';

  const iconMap: Record<string, string> = {
    ts: 'TS',
    tsx: 'TSX',
    js: 'JS',
    jsx: 'JSX',
    json: '{}',
    md: 'MD',
    css: 'CSS',
    html: 'HTML',
    yml: 'YML',
    yaml: 'YML',
    sh: 'SH',
    py: 'PY',
    go: 'GO',
    rs: 'RS',
    sql: 'SQL',
    txt: 'TXT',
  };

  return iconMap[ext] || 'FILE';
}

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function TreeItem({ node, depth, expandedPaths, loadingPaths, onToggle, onOpenFile }: TreeItemProps) {
  const isExpanded = expandedPaths.has(node.path);
  const isLoading = loadingPaths.has(node.path);

  const handleClick = () => {
    if (node.isDirectory) {
      onToggle(node.path);
    } else {
      onOpenFile(node.path);
    }
  };

  return (
    <div className="vuhlp-file-explorer__item-container">
      <button
        className={`vuhlp-file-explorer__item ${node.isDirectory ? 'vuhlp-file-explorer__item--directory' : 'vuhlp-file-explorer__item--file'}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={handleClick}
      >
        {node.isDirectory ? (
          <span className="vuhlp-file-explorer__chevron">
            {isLoading ? '...' : isExpanded ? '▼' : '▶'}
          </span>
        ) : (
          <span className="vuhlp-file-explorer__file-icon">{getFileIcon(node.name)}</span>
        )}
        <span className="vuhlp-file-explorer__name">{node.name}</span>
      </button>

      {node.isDirectory && isExpanded && node.children && (
        <div className="vuhlp-file-explorer__children">
          {node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ repoPath, onFetchFs, onOpenFile }: FileExplorerProps) {
  const [rootEntries, setRootEntries] = useState<TreeNode[]>([]);
  const [childrenMap, setChildrenMap] = useState<Record<string, TreeNode[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load root directory when repoPath changes
  useEffect(() => {
    if (!repoPath) {
      setRootEntries([]);
      setChildrenMap({});
      setExpandedPaths(new Set());
      return;
    }

    setLoading(true);
    setError(null);

    onFetchFs(repoPath, true)
      .then((response) => {
        if (response.error) {
          setError(response.error);
          setRootEntries([]);
        } else {
          setRootEntries(response.entries.map((e) => ({ ...e, children: undefined, expanded: false })));
        }
      })
      .catch((err) => {
        setError(err.message || 'Failed to load directory');
        setRootEntries([]);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [repoPath, onFetchFs]);

  const handleToggle = useCallback(async (dirPath: string) => {
    const isCurrentlyExpanded = expandedPaths.has(dirPath);

    if (isCurrentlyExpanded) {
      // Collapse
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    } else {
      // Expand and load children if not already loaded
      if (!childrenMap[dirPath]) {
        setLoadingPaths((prev) => new Set(prev).add(dirPath));

        try {
          const response = await onFetchFs(dirPath, true);
          if (!response.error) {
            setChildrenMap((prev) => ({
              ...prev,
              [dirPath]: response.entries.map((e) => ({ ...e, children: undefined, expanded: false })),
            }));
          }
        } catch (err) {
          // Ignore errors for now
        } finally {
          setLoadingPaths((prev) => {
            const next = new Set(prev);
            next.delete(dirPath);
            return next;
          });
        }
      }

      setExpandedPaths((prev) => new Set(prev).add(dirPath));
    }
  }, [expandedPaths, childrenMap, onFetchFs]);

  // Build the tree by attaching children
  const buildTree = useCallback((entries: TreeNode[]): TreeNode[] => {
    return entries.map((entry) => {
      if (entry.isDirectory && childrenMap[entry.path]) {
        return {
          ...entry,
          children: buildTree(childrenMap[entry.path]),
        };
      }
      return entry;
    });
  }, [childrenMap]);

  if (!repoPath) {
    return (
      <div className="vuhlp-file-explorer vuhlp-file-explorer--empty">
        <div className="vuhlp-file-explorer__empty-message">
          <FontAwesomeIcon icon={faFolderOpen} className="vuhlp-file-explorer__empty-icon" />
          <p>Select a session to browse files</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="vuhlp-file-explorer vuhlp-file-explorer--loading">
        <div className="vuhlp-file-explorer__loading">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="vuhlp-file-explorer vuhlp-file-explorer--error">
        <div className="vuhlp-file-explorer__error">{error}</div>
      </div>
    );
  }

  const tree = buildTree(rootEntries);

  return (
    <div className="vuhlp-file-explorer">
      <div className="vuhlp-file-explorer__header">
        <span className="vuhlp-file-explorer__path" title={repoPath}>
          {repoPath.split('/').pop() || repoPath}
        </span>
      </div>
      <div className="vuhlp-file-explorer__tree">
        {tree.length === 0 ? (
          <div className="vuhlp-file-explorer__empty-dir">Empty directory</div>
        ) : (
          tree.map((node) => (
            <TreeItem
              key={node.path}
              node={node}
              depth={0}
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              onToggle={handleToggle}
              onOpenFile={onOpenFile}
            />
          ))
        )}
      </div>
    </div>
  );
}
