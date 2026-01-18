/**
 * Header component with run-level controls
 * - Auto/Interactive toggle
 * - Planning/Implementation toggle
 * - Master Start/Stop
 * - View mode controls
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { NodePermissions } from '@vuhlp/contracts';
import { useRunStore } from '../stores/runStore';
import { updateRun, updateNode } from '../lib/api';
import { ArrowLeft, SunLight, HalfMoon, Settings, Play, Pause } from 'iconoir-react';
import './Header.css';

interface HeaderProps {
  minimal?: boolean;
}

export function Header({ minimal = false }: HeaderProps) {
  const run = useRunStore((s) => s.run);
  const viewMode = useRunStore((s) => s.ui.viewMode);
  const theme = useRunStore((s) => s.ui.theme);
  const setRun = useRunStore((s) => s.setRun);
  const setViewMode = useRunStore((s) => s.setViewMode);
  const toggleTheme = useRunStore((s) => s.toggleTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cliModeSaving, setCliModeSaving] = useState(false);
  const [cliModeError, setCliModeError] = useState<string | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);

  const isRunning = run?.status === 'running';
  const isStopped = run?.status === 'stopped';
  const isAuto = run?.mode === 'AUTO';
  const isImplementation = run?.globalMode === 'IMPLEMENTATION';
  const cliModeValue = useMemo<'skip' | 'gated' | 'mixed'>(() => {
    if (!run) return 'mixed';
    const modes = new Set(
      Object.values(run.nodes).map((node) => node.permissions.cliPermissionsMode)
    );
    if (modes.size === 1) {
      return modes.values().next().value;
    }
    return 'mixed';
  }, [run]);

  const updateRunState = async (patch: { status?: 'running' | 'paused' | 'stopped'; mode?: 'AUTO' | 'INTERACTIVE'; globalMode?: 'PLANNING' | 'IMPLEMENTATION' }) => {
    if (!run) return;
    try {
      const updated = await updateRun(run.id, patch);
      setRun(updated);
    } catch (error) {
      console.error('[header] failed to update run', error);
    }
  };

  const handleToggleRun = () => {
    void updateRunState({ status: isRunning ? 'paused' : 'running' });
  };

  const handleStopRun = () => {
    void updateRunState({ status: 'stopped' });
  };

  const handleToggleOrchestrationMode = () => {
    void updateRunState({ mode: isAuto ? 'INTERACTIVE' : 'AUTO' });
  };

  const handleToggleGlobalMode = () => {
    void updateRunState({ globalMode: isImplementation ? 'PLANNING' : 'IMPLEMENTATION' });
  };

  const handleCliPermissionsChange = async (mode: NodePermissions['cliPermissionsMode']) => {
    if (!run) return;
    setCliModeSaving(true);
    setCliModeError(null);
    const nodes = Object.values(run.nodes);
    const updates = nodes.map((node) => {
      const permissions = { ...node.permissions, cliPermissionsMode: mode };
      return updateNode(run.id, node.id, { permissions }, { permissions });
    });
    const results = await Promise.allSettled(updates);
    if (results.some((result) => result.status === 'rejected')) {
      setCliModeError('Some nodes failed to update.');
    }
    setCliModeSaving(false);
  };

  useEffect(() => {
    if (!settingsOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (settingsRef.current && !settingsRef.current.contains(target)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [settingsOpen]);

  if (minimal) {
    return (
      <header className="header header--minimal">
        <div className="header__left">
          <button
            className="header__back-btn"
            onClick={() => setViewMode('graph')}
            title="Back to graph (f)"
          >
            <ArrowLeft width={16} height={16} />
          </button>
        </div>
        <div className="header__center">
          <span className="header__logo">vuhlp code</span>
        </div>
        <div className="header__right">
          <button
            className="header__theme-toggle"
            onClick={toggleTheme}
            title="Toggle light/dark theme"
          >
            {theme === 'dark' ? <HalfMoon width={16} height={16} /> : <SunLight width={16} height={16} />}
          </button>
          {run && (
            <div className="header__status">
              <span className={`header__status-dot header__status-dot--${run.status}`} />
              <span className="header__status-text">{run.status.toUpperCase()}</span>
            </div>
          )}
        </div>
      </header>
    );
  }

  return (
    <header className="header">
      <div className="header__left">
        <span className="header__logo">vuhlp code</span>
      </div>

      <div className="header__center">
        {run && (
          <div className="header__controls">
            {/* Orchestration Mode Toggle */}
            <button
              className={`header__toggle ${isAuto ? 'header__toggle--active' : ''}`}
              onClick={handleToggleOrchestrationMode}
              title="Toggle Auto/Interactive mode"
            >
              <span className="header__toggle-label">MODE</span>
              <span className="header__toggle-value">{run.mode}</span>
            </button>

            {/* Global Mode Toggle */}
            <button
              className={`header__toggle ${isImplementation ? 'header__toggle--active' : ''}`}
              onClick={handleToggleGlobalMode}
              title="Toggle Planning/Implementation mode"
            >
              <span className="header__toggle-label">GLOBAL</span>
              <span className="header__toggle-value">{run.globalMode}</span>
            </button>

            {/* Master Start/Stop */}
            <button
              className={`header__action ${isRunning ? 'header__action--pause' : 'header__action--start'}`}
              onClick={handleToggleRun}
              title={isRunning ? 'Pause run' : 'Start run'}
            >
              {isRunning ? <Pause width={16} height={16} /> : <Play width={16} height={16} />}
            </button>
            <button
              className="header__action header__action--stop"
              onClick={handleStopRun}
              disabled={isStopped}
              title="Stop run (terminate sessions)"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <rect x="3" y="3" width="10" height="10" rx="2" />
              </svg>
            </button>
          </div>
        )}
      </div>

      <div className="header__right">
        <button
          className="header__theme-toggle"
          onClick={toggleTheme}
          title="Toggle light/dark theme"
        >
          {theme === 'dark' ? <HalfMoon width={16} height={16} /> : <SunLight width={16} height={16} />}
        </button>

        <div className="header__menu" ref={settingsRef}>
          <button
            className="header__action header__action--neutral header__action--compact"
            onClick={() => setSettingsOpen((open) => !open)}
            title="Settings"
            type="button"
            aria-haspopup="true"
            aria-expanded={settingsOpen}
          >
            <Settings width={16} height={16} />
          </button>
          {settingsOpen && (
            <div className="header__menu-panel">
              <div className="header__menu-title">Global Controls</div>
              <div className="header__menu-row">
                <span className="header__menu-label">CLI Permissions</span>
                <select
                  className="header__menu-select"
                  value={cliModeValue}
                  onChange={(event) =>
                    handleCliPermissionsChange(
                      event.target.value as NodePermissions['cliPermissionsMode']
                    )
                  }
                  disabled={!run || cliModeSaving}
                >
                  <option value="mixed" disabled>
                    MIXED
                  </option>
                  <option value="skip">SKIP</option>
                  <option value="gated">GATED</option>
                </select>
              </div>
              <p className="header__menu-note">
                Applies to all nodes. You can still override per node.
              </p>
              {run.cwd && (
                <div className="header__menu-row header__menu-row--meta">
                  <span className="header__menu-label">Working Directory</span>
                  <span className="header__menu-value" title={run.cwd}>
                    {run.cwd}
                  </span>
                </div>
              )}
              {cliModeError && <p className="header__menu-error">{cliModeError}</p>}
            </div>
          )}
        </div>
        {/* View Mode Selector */}
        <div className="header__view-modes">
          <button
            className={`header__view-btn ${viewMode === 'graph' ? 'header__view-btn--active' : ''}`}
            onClick={() => setViewMode('graph')}
            title="Graph + Inspector view"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="1" y="1" width="6" height="6" rx="1" />
              <rect x="9" y="1" width="6" height="6" rx="1" />
              <rect x="1" y="9" width="6" height="6" rx="1" />
              <rect x="9" y="9" width="6" height="6" rx="1" />
            </svg>
          </button>
          <button
            className={`header__view-btn ${viewMode === 'collapsed' ? 'header__view-btn--active' : ''}`}
            onClick={() => setViewMode('collapsed')}
            title="Collapsed overview (shift+f)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="1" y="3" width="14" height="2" rx="0.5" />
              <rect x="1" y="7" width="14" height="2" rx="0.5" />
              <rect x="1" y="11" width="14" height="2" rx="0.5" />
            </svg>
          </button>
        </div>

        {run && (
          <div className="header__status">
            <span className={`header__status-dot header__status-dot--${run.status}`} />
            <span className="header__status-text">{run.status.toUpperCase()}</span>
          </div>
        )}
      </div>
    </header>
  );
}
