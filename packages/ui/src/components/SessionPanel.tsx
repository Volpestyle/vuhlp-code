import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RunState } from '@vuhlp/contracts';
import { createRun, deleteRun, getRun, listRuns } from '../lib/api';
import { useRunStore } from '../stores/runStore';
import { RefreshDouble, Plus, Check, Xmark, EditPencil, Trash, SidebarCollapse, SidebarExpand } from 'iconoir-react';
import './SessionPanel.css';

const RUN_STORAGE_KEY = 'vuhlp-active-run-id';
const RUN_NAMES_KEY = 'vuhlp-run-names';

const sortRuns = (runs: RunState[]) =>
  [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString('en-US', { hour12: false });
}

function loadRunNames(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const stored = window.localStorage.getItem(RUN_NAMES_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as Record<string, string>;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch (error) {
    console.warn('[sessions] failed to load run names', error);
  }
  return {};
}

function persistRunNames(names: Record<string, string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RUN_NAMES_KEY, JSON.stringify(names));
  } catch (error) {
    console.warn('[sessions] failed to persist run names', error);
  }
}

function persistRunSelection(runId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RUN_STORAGE_KEY, runId);
  } catch (error) {
    console.warn('[sessions] failed to persist run selection', error);
  }
}

interface SessionPanelProps {
  collapsed?: boolean;
}

export function SessionPanel({ collapsed = false }: SessionPanelProps) {
  const activeRun = useRunStore((s) => s.run);
  const setRun = useRunStore((s) => s.setRun);
  const selectNode = useRunStore((s) => s.selectNode);
  const selectEdge = useRunStore((s) => s.selectEdge);
  const toggleSidebar = useRunStore((s) => s.toggleSidebar);
  const [runs, setRuns] = useState<RunState[]>([]);
  const [runNames, setRunNames] = useState<Record<string, string>>(() => loadRunNames());
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const activeRunId = activeRun?.id ?? null;

  const upsertRun = useCallback((run: RunState) => {
    setRuns((prev) => sortRuns([...prev.filter((item) => item.id !== run.id), run]));
  }, []);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listRuns();
      setRuns(sortRuns(list));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!activeRun) return;
    upsertRun(activeRun);
  }, [activeRun, upsertRun]);

  const handleSelectRun = useCallback(
    async (runId: string) => {
      if (runId === activeRunId || switchingId) return;
      setSwitchingId(runId);
      setEditingId(null);
      setEditValue('');
      setError(null);
      try {
        const selected = await getRun(runId);
        setRun(selected);
        selectNode(null);
        selectEdge(null);
        upsertRun(selected);
        persistRunSelection(selected.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        setSwitchingId(null);
      }
    },
    [activeRunId, selectEdge, selectNode, setRun, switchingId, upsertRun]
  );

  const handleCreateRun = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setEditingId(null);
    setEditValue('');
    setError(null);
    try {
      const created = await createRun();
      setRun(created);
      selectNode(null);
      selectEdge(null);
      upsertRun(created);
      persistRunSelection(created.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setCreating(false);
    }
  }, [creating, selectEdge, selectNode, setRun, upsertRun]);

  const handleStartRename = useCallback(
    (runId: string) => {
      setEditingId(runId);
      setEditValue(runNames[runId] ?? '');
    },
    [runNames]
  );

  const handleCancelRename = useCallback(() => {
    setEditingId(null);
    setEditValue('');
  }, []);

  const handleSaveRename = useCallback(
    (runId: string) => {
      const trimmed = editValue.trim();
      setRunNames((prev) => {
        const next = { ...prev };
        if (trimmed) {
          next[runId] = trimmed;
        } else {
          delete next[runId];
        }
        persistRunNames(next);
        return next;
      });
      setEditingId(null);
      setEditValue('');
    },
    [editValue]
  );

  const handleDeleteRun = useCallback(
    async (run: RunState) => {
      if (deletingId) return;
      const label = runNames[run.id]?.trim() || `Run ${run.id.slice(0, 6)}`;
      const confirmed = window.confirm(
        `Delete ${label}? This stops nodes and removes the session data.`
      );
      if (!confirmed) return;
      setDeletingId(run.id);
      setError(null);
      if (editingId === run.id) {
        setEditingId(null);
        setEditValue('');
      }
      try {
        await deleteRun(run.id);
        setRuns((prev) => prev.filter((item) => item.id !== run.id));
        setRunNames((prev) => {
          if (!prev[run.id]) return prev;
          const next = { ...prev };
          delete next[run.id];
          persistRunNames(next);
          return next;
        });
        if (activeRunId === run.id) {
          const remaining = runs.filter((item) => item.id !== run.id);
          if (remaining.length > 0) {
            const nextId = sortRuns(remaining)[0].id;
            const selected = await getRun(nextId);
            setRun(selected);
            selectNode(null);
            selectEdge(null);
            upsertRun(selected);
            persistRunSelection(selected.id);
          } else {
            const created = await createRun();
            setRun(created);
            selectNode(null);
            selectEdge(null);
            upsertRun(created);
            persistRunSelection(created.id);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        setDeletingId(null);
      }
    },
    [
      activeRunId,
      deletingId,
      editingId,
      runNames,
      runs,
      selectEdge,
      selectNode,
      setRun,
      upsertRun,
    ]
  );

  const summary = useMemo(() => {
    if (loading) return 'Loading sessions';
    if (runs.length === 0) return 'No active sessions';
    return `${runs.length} session${runs.length === 1 ? '' : 's'}`;
  }, [loading, runs.length]);

  if (collapsed) {
    return (
      <div className="session-panel session-panel--collapsed">
        <button
          className="session-panel__expand-btn"
          type="button"
          onClick={toggleSidebar}
          title="Expand sessions panel"
          aria-label="Expand sessions panel"
        >
          <SidebarExpand width={16} height={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="inspector session-panel">
      <header className="inspector__header">
        <div className="inspector__title-row">
          <h2 className="inspector__title">Sessions</h2>
          <div className="session-panel__actions">
            <button
              className="session-panel__button"
              type="button"
              onClick={loadRuns}
              disabled={loading}
              title="Refresh sessions"
              aria-label="Refresh sessions"
            >
              <RefreshDouble width={16} height={16} />
            </button>
            <button
              className="session-panel__button session-panel__button--primary"
              type="button"
              onClick={handleCreateRun}
              disabled={creating}
              title="Create new session"
              aria-label="Create new session"
            >
              <Plus width={16} height={16} />
            </button>
            <button
              className="session-panel__collapse-btn"
              type="button"
              onClick={toggleSidebar}
              title="Collapse sessions panel"
              aria-label="Collapse sessions panel"
            >
              <SidebarCollapse width={16} height={16} />
            </button>
          </div>
        </div>
        <div className="session-panel__summary">{summary}</div>
      </header>

      <div className="session-panel__content">
        {error && <div className="session-panel__error">{error}</div>}
        {runs.length === 0 && !loading ? (
          <div className="session-panel__empty">
            <span>No sessions yet</span>
            <button
              className="session-panel__button session-panel__button--primary"
              type="button"
              onClick={handleCreateRun}
              disabled={creating}
            >
              Create session
            </button>
          </div>
        ) : (
          <ul className="session-panel__list">
            {runs.map((run) => {
              const isActive = run.id === activeRunId;
              const isSwitching = switchingId === run.id;
              const isDeleting = deletingId === run.id;
              const isEditing = editingId === run.id;
              const isBusy = isSwitching || isDeleting;
              const nodeCount = Object.keys(run.nodes).length;
              const edgeCount = Object.keys(run.edges).length;
              const displayName = runNames[run.id]?.trim();
              const label = displayName || `Run ${run.id.slice(0, 6)}`;
              return (
                <li key={run.id} className="session-panel__list-item">
                  <div
                    className={`session-panel__item ${isActive ? 'session-panel__item--active' : ''} ${
                      isBusy ? 'session-panel__item--busy' : ''
                    }`}
                    aria-current={isActive ? 'true' : undefined}
                  >
                    {isEditing ? (
                      <div className="session-panel__item-main session-panel__item-main--editing">
                        <input
                          className="session-panel__rename-input"
                          type="text"
                          value={editValue}
                          placeholder="Session name"
                          onChange={(event) => setEditValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              handleSaveRename(run.id);
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              handleCancelRename();
                            }
                          }}
                          autoFocus
                        />
                        <div className="session-panel__item-meta">
                          <span>{nodeCount} nodes</span>
                          <span>{edgeCount} edges</span>
                          <span>{formatTime(run.updatedAt)}</span>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="session-panel__item-main"
                        type="button"
                        onClick={() => handleSelectRun(run.id)}
                        disabled={isBusy}
                      >
                        <div className="session-panel__item-header">
                          <span className="session-panel__item-title">{label}</span>
                          <span className={`session-panel__status session-panel__status--${run.status}`}>
                            {isSwitching ? 'loading' : run.status}
                          </span>
                        </div>
                        <div className="session-panel__item-meta">
                          <span>{nodeCount} nodes</span>
                          <span>{edgeCount} edges</span>
                          <span>{formatTime(run.updatedAt)}</span>
                        </div>
                      </button>
                    )}
                    <div className="session-panel__item-actions">
                      {isEditing ? (
                        <>
                          <button
                            className="session-panel__icon-button session-panel__icon-button--primary"
                            type="button"
                            onClick={() => handleSaveRename(run.id)}
                            disabled={!editValue.trim()}
                            title="Save"
                            aria-label="Save session name"
                          >
                            <Check width={14} height={14} />
                          </button>
                          <button
                            className="session-panel__icon-button"
                            type="button"
                            onClick={handleCancelRename}
                            title="Cancel"
                            aria-label="Cancel rename"
                          >
                            <Xmark width={14} height={14} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="session-panel__icon-button"
                            type="button"
                            onClick={() => handleStartRename(run.id)}
                            disabled={isBusy}
                            title="Rename"
                            aria-label="Rename session"
                          >
                            <EditPencil width={14} height={14} />
                          </button>
                          <button
                            className="session-panel__icon-button session-panel__icon-button--danger"
                            type="button"
                            onClick={() => handleDeleteRun(run)}
                            disabled={isBusy}
                            title="Delete"
                            aria-label="Delete session"
                          >
                            <Trash width={14} height={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
