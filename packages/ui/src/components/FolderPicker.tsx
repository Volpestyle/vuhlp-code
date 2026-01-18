
import { useEffect, useState } from 'react';
import { listDirectory } from '../lib/api';
import type { FileEntry } from '@vuhlp/contracts';
import { Folder, NavArrowUp, Page } from 'iconoir-react';
import './FolderPicker.css';

interface FolderPickerProps {
  initialPath?: string;
  onSelect: (path: string) => void;
}

export function FolderPicker({ initialPath, onSelect }: FolderPickerProps) {
  const [path, setPath] = useState(initialPath || '');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState<string | undefined>(undefined);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = await listDirectory(path);
        if (mounted) {
          setPath(result.current);
          setParentPath(result.parent);
          setEntries(result.entries.filter((e) => e.isDirectory));
          onSelect(result.current); // Update parent with resolved path
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void load();
    return () => {
      mounted = false;
    };
  }, [path, onSelect]);

  const handleNavigate = (newPath: string) => {
    setPath(newPath);
  };

  const handleUp = () => {
    if (parentPath) {
      setPath(parentPath);
    }
  };

  return (
    <div className="folder-picker">
      <div className="folder-picker__header">
        <button
          className="folder-picker__up-btn"
          type="button"
          onClick={handleUp}
          disabled={!parentPath || loading}
          title="Go up"
        >
          <NavArrowUp width={16} height={16} />
        </button>
        <div className="folder-picker__path" title={path}>
          {path || 'Root'}
        </div>
      </div>

      {error && <div className="folder-picker__error">{error}</div>}

      <div className="folder-picker__list">
        {loading && entries.length === 0 ? (
          <div className="folder-picker__empty">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="folder-picker__empty">No subfolders</div>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.path}
              className="folder-picker__item"
              type="button"
              onClick={() => handleNavigate(entry.path)}
            >
              <Folder className="folder-picker__item-icon" width={16} height={16} />
              <span>{entry.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
