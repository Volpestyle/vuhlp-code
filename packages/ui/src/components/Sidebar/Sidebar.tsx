import { useState, useMemo, useCallback } from 'react';
import type { Run, FsResponse, ProviderInfo } from '../../types';
import { Button } from '../Button';
import { FileExplorer } from '../FileExplorer';
import './Sidebar.css';

export type RunsFilter = 'active' | 'all';
export type SidebarTab = 'sessions' | 'explorer';

export interface SidebarProps {
  runs: Run[];
  providers: ProviderInfo[];
  activeRunId: string | null;
  onSelectRun: (id: string) => void;
  onDeleteRun: (id: string) => void;
  onArchiveRun: (id: string) => void;
  onUnarchiveRun: (id: string) => void;
  onRenameRun: (id: string, name: string) => void;
  onCreateRun: (prompt: string, repoPath: string) => Promise<string | void>;
  onFetchFs: (path: string, includeFiles?: boolean) => Promise<FsResponse>;
  onFilterChange?: (filter: RunsFilter) => void;
  onOpenFile: (path: string) => void;
  isLoadingRuns?: boolean;
  isLoadingProviders?: boolean;
}

export function Sidebar({
  runs,
  providers,
  activeRunId,
  onSelectRun,
  onDeleteRun,
  onArchiveRun,
  onUnarchiveRun,
  onRenameRun,
  onCreateRun,
  onFetchFs,
  onFilterChange,
  onOpenFile,
  isLoadingRuns = false,
  isLoadingProviders = false,
}: SidebarProps) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('sessions');
  const [repoPath, setRepoPath] = useState(() => localStorage.getItem('vuhlp_last_repo_path') || '');
  const [isCreating, setIsCreating] = useState(false);
  const [showPathBrowser, setShowPathBrowser] = useState(false);
  const [browserPath, setBrowserPath] = useState('');
  const [browserParent, setBrowserParent] = useState<string | undefined>(undefined);
  const [browserEntries, setBrowserEntries] = useState<FsResponse['entries']>([]);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [runsFilter, setRunsFilter] = useState<RunsFilter>('active');
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  // Get the repo path for the active run (for file explorer)
  const activeRepoPath = useMemo(() => {
    if (!activeRunId) return null;
    const activeRun = runs.find(r => r.id === activeRunId);
    return activeRun?.repoPath ?? null;
  }, [activeRunId, runs]);

  // Wrapper for onFetchFs that handles includeFiles parameter
  const handleFetchFs = useCallback((path: string, includeFiles?: boolean) => {
    return onFetchFs(path, includeFiles);
  }, [onFetchFs]);

  // Filter and sort runs
  const sortedRuns = useMemo(() => {
    const filtered = runsFilter === 'active'
      ? runs.filter(r => !r.archived)
      : runs;
    return [...filtered].sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [runs, runsFilter]);

  const handleFilterChange = (filter: RunsFilter) => {
    setRunsFilter(filter);
    onFilterChange?.(filter);
  };

  const handleCreate = async () => {
    if (!repoPath.trim()) return;
    setIsCreating(true);
    try {
      localStorage.setItem('vuhlp_last_repo_path', repoPath);
      const newRunId = await onCreateRun("(Session Started)", repoPath);
      
      // If we got a runId, wait for it to appear in the list
      if (newRunId) {
        // Poll for the new run
        const startTime = Date.now();
        while (Date.now() - startTime < 5000) { // 5s timeout
          const found = runs.some(r => r.id === newRunId);
          if (found) break;
          await new Promise(r => setTimeout(r, 100));
        }
      }
      // Don't clear repo path so it stays for next time
      // setRepoPath('');
    } catch (err) {
      console.error('Failed to create run:', err);
    } finally {
      setIsCreating(false);
    }
  };

  const handleBrowse = async (path: string) => {
    setBrowserLoading(true);
    try {
      const result = await onFetchFs(path || '/');
      setBrowserPath(result.path);
      setBrowserParent(result.parent);
      setBrowserEntries(result.entries.filter(e => e.isDirectory));
    } catch (err) {
      console.error('Failed to browse:', err);
    } finally {
      setBrowserLoading(false);
    }
  };

  const openBrowser = () => {
    setShowPathBrowser(true);
    handleBrowse(repoPath || '~');
  };

  const selectPath = (path: string) => {
    setRepoPath(path);
    localStorage.setItem('vuhlp_last_repo_path', path);
    setShowPathBrowser(false);
  };

  const getStatusClass = (status: Run['status']) => {
    return `vuhlp-sidebar__run-status--${status}`;
  };

  const formatDate = (date: string) => {
    const d = new Date(date);
    const now = new Date();
    const diff = now.getTime() - d.getTime();

    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  };

  const startRename = (run: Run) => {
    setEditingRunId(run.id);
    setEditingName(run.name || '');
  };

  const saveRename = () => {
    if (editingRunId) {
      onRenameRun(editingRunId, editingName);
      setEditingRunId(null);
      setEditingName('');
    }
  };

  const cancelRename = () => {
    setEditingRunId(null);
    setEditingName('');
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  };

  return (
    <div className="vuhlp-sidebar">
      {/* Tab Bar */}
      <div className="vuhlp-sidebar__tabs">
        <button
          className={`vuhlp-sidebar__tab ${activeTab === 'sessions' ? 'vuhlp-sidebar__tab--active' : ''}`}
          onClick={() => setActiveTab('sessions')}
        >
          Sessions
        </button>
        <button
          className={`vuhlp-sidebar__tab ${activeTab === 'explorer' ? 'vuhlp-sidebar__tab--active' : ''}`}
          onClick={() => setActiveTab('explorer')}
        >
          Explorer
        </button>
      </div>

      {/* Sessions Tab Content */}
      {activeTab === 'sessions' && (
        <>
          {/* New Session Form */}
          <div className="vuhlp-sidebar__create">
        <div className="vuhlp-sidebar__section-header">New Session</div>

        <div className="vuhlp-sidebar__form">
          <div className="vuhlp-sidebar__field">
            <label className="vuhlp-sidebar__label">Repository</label>
            <div className="vuhlp-sidebar__path-input">
              <input
                type="text"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder="/path/to/repo"
                className="vuhlp-sidebar__input"
              />
              <button
                type="button"
                className="vuhlp-sidebar__browse-btn"
                onClick={openBrowser}
                title="Browse"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2 5h12M2 5v7a1 1 0 001 1h10a1 1 0 001-1V5M2 5V4a1 1 0 011-1h4l1 2h5a1 1 0 011 1v0" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>

          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={!repoPath.trim() || isCreating}
            loading={isCreating}
            className="vuhlp-sidebar__create-btn"
          >
            Start Session
          </Button>
        </div>
      </div>

      {/* Path Browser Modal */}
      {showPathBrowser && (
        <div className="vuhlp-sidebar__browser-overlay" onClick={() => setShowPathBrowser(false)}>
          <div className="vuhlp-sidebar__browser" onClick={(e) => e.stopPropagation()}>
            <div className="vuhlp-sidebar__browser-header">
              <span>Select Directory</span>
              <button onClick={() => setShowPathBrowser(false)} className="vuhlp-sidebar__browser-close">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="vuhlp-sidebar__browser-path">
              <button
                onClick={() => handleBrowse(browserParent || '/')}
                disabled={!browserParent || browserPath === '/'}
                className="vuhlp-sidebar__browser-up"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M8 12V4M4 8l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <span className="vuhlp-sidebar__browser-current">{browserPath}</span>
            </div>

            <div className="vuhlp-sidebar__browser-list">
              {browserLoading ? (
                <div className="vuhlp-sidebar__browser-loading">Loading...</div>
              ) : browserEntries.length === 0 ? (
                <div className="vuhlp-sidebar__browser-empty">No subdirectories</div>
              ) : (
                browserEntries.map((entry) => (
                  <button
                    key={entry.path}
                    className="vuhlp-sidebar__browser-item"
                    onClick={() => handleBrowse(entry.path)}
                    onDoubleClick={() => selectPath(entry.path)}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M2 5h12M2 5v7a1 1 0 001 1h10a1 1 0 001-1V5M2 5V4a1 1 0 011-1h4l1 2h5a1 1 0 011 1v0" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span>{entry.name}</span>
                  </button>
                ))
              )}
            </div>

            <div className="vuhlp-sidebar__browser-footer">
              <Button variant="secondary" size="sm" onClick={() => setShowPathBrowser(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={() => selectPath(browserPath)}>
                Select
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Sessions List */}
      <div className="vuhlp-sidebar__runs">
        <div className="vuhlp-sidebar__section-header">
          <span className="vuhlp-sidebar__section-title">
            Sessions
            {isLoadingRuns && <span className="vuhlp-sidebar__loading-indicator" />}
          </span>
          <div className="vuhlp-sidebar__filter-toggle">
            <button
              className={`vuhlp-sidebar__filter-btn ${runsFilter === 'active' ? 'vuhlp-sidebar__filter-btn--active' : ''}`}
              onClick={() => handleFilterChange('active')}
            >
              Active
            </button>
            <button
              className={`vuhlp-sidebar__filter-btn ${runsFilter === 'all' ? 'vuhlp-sidebar__filter-btn--active' : ''}`}
              onClick={() => handleFilterChange('all')}
            >
              All
            </button>
          </div>
        </div>

        <div className="vuhlp-sidebar__runs-list">
          {sortedRuns.length === 0 ? (
            <div className="vuhlp-sidebar__empty">
              {isLoadingRuns ? 'Loading sessions...' : runsFilter === 'active' ? 'No active sessions' : 'No sessions yet'}
            </div>
          ) : (
            sortedRuns.map((run) => (
              <div
                role="button"
                tabIndex={0}
                key={run.id}
                className={`vuhlp-sidebar__run ${activeRunId === run.id ? 'vuhlp-sidebar__run--active' : ''} ${run.archived ? 'vuhlp-sidebar__run--archived' : ''}`}
                onClick={() => onSelectRun(run.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectRun(run.id);
                  }
                }}
              >
                <div className="vuhlp-sidebar__run-header">
                  <span className={`vuhlp-sidebar__run-status ${getStatusClass(run.status)}`} />
                  {run.archived && (
                    <span className="vuhlp-sidebar__run-archived-icon" title="Archived">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M2 4h12v2H2V4zM3 6v7a1 1 0 001 1h8a1 1 0 001-1V6M6 9h4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                  {editingRunId === run.id ? (
                    <input
                      type="text"
                      className="vuhlp-sidebar__run-name-input"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={handleRenameKeyDown}
                      onBlur={saveRename}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      placeholder="Enter name..."
                    />
                  ) : (
                    <span className="vuhlp-sidebar__run-id">{run.name || run.id.slice(0, 8)}</span>
                  )}
                  <div className="vuhlp-sidebar__run-actions">
                    {run.archived ? (
                      <>
                        <button
                          className="vuhlp-sidebar__run-action vuhlp-sidebar__run-rename"
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(run);
                          }}
                          title="Rename session"
                        >
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M11.5 2.5l2 2M2 11l7-7 2 2-7 7H2v-2z" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                        <button
                          className="vuhlp-sidebar__run-action vuhlp-sidebar__run-unarchive"
                          onClick={(e) => {
                            e.stopPropagation();
                            onUnarchiveRun(run.id);
                          }}
                          title="Restore session"
                        >
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M8 12V4M4 8l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                        <button
                          className="vuhlp-sidebar__run-action vuhlp-sidebar__run-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteRun(run.id);
                          }}
                          title="Delete permanently"
                        >
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M5 6v6M8 6v6M11 6v6M3 4h10M4 4l1 9a1 1 0 001 1h4a1 1 0 001-1l1-9M6 4V3a1 1 0 011-1h2a1 1 0 011 1v1" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="vuhlp-sidebar__run-action vuhlp-sidebar__run-rename"
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(run);
                          }}
                          title="Rename session"
                        >
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M11.5 2.5l2 2M2 11l7-7 2 2-7 7H2v-2z" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                        <button
                          className="vuhlp-sidebar__run-action vuhlp-sidebar__run-archive"
                          onClick={(e) => {
                            e.stopPropagation();
                            onArchiveRun(run.id);
                          }}
                          title="Archive session"
                        >
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M2 4h12v2H2V4zM3 6v7a1 1 0 001 1h8a1 1 0 001-1V6M6 9h4" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                  <span className="vuhlp-sidebar__run-time">{formatDate(run.createdAt)}</span>
                </div>
                <div className="vuhlp-sidebar__run-prompt" title={run.repoPath}>{run.repoPath}</div>
                {run.phase && (
                  <div className="vuhlp-sidebar__run-phase">{run.phase}</div>
                )}
              </div>
            ))
          )}
          </div>
        </div>

        {/* Providers */}
        <div className="vuhlp-sidebar__providers">
          <div className="vuhlp-sidebar__section-header">
            Providers
            {isLoadingProviders && <span className="vuhlp-sidebar__loading-indicator" />}
          </div>
          <div className="vuhlp-sidebar__providers-list">
            {providers.length === 0 ? (
              <div className="vuhlp-sidebar__empty">
                {isLoadingProviders ? 'Loading...' : 'No providers configured'}
              </div>
            ) : (
              providers.map((provider) => (
                <div key={provider.id} className="vuhlp-sidebar__provider">
                  <span className={`vuhlp-sidebar__provider-dot vuhlp-sidebar__provider-dot--${provider.kind}`} />
                  <span>{provider.displayName}</span>
                  {provider.health && provider.health !== 'unknown' && (
                    <span className={`vuhlp-sidebar__provider-health vuhlp-sidebar__provider-health--${provider.health}`} />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </>
    )}

      {/* Explorer Tab Content */}
      {activeTab === 'explorer' && (
        <div className="vuhlp-sidebar__explorer">
          <FileExplorer
            repoPath={activeRepoPath}
            onFetchFs={handleFetchFs}
            onOpenFile={onOpenFile}
          />
        </div>
      )}
    </div>
  );
}
