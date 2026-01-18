import { type FormEvent, useEffect, useState } from 'react';
import type { GlobalMode, OrchestrationMode } from '@vuhlp/contracts';
import { createRun } from '../lib/api';
import { useRunStore } from '../stores/runStore';
import { Code, Network, Folder, Plus } from 'iconoir-react';
import { FolderPicker } from './FolderPicker';
import './NewRunModal.css';

interface NewRunModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (run: any) => void;
}

export function NewRunModal({ open, onClose, onSuccess }: NewRunModalProps) {
  const setRun = useRunStore((s) => s.setRun);
  const selectNode = useRunStore((s) => s.selectNode);
  const selectEdge = useRunStore((s) => s.selectEdge);
  
  const [globalMode, setGlobalMode] = useState<GlobalMode>('IMPLEMENTATION');
  const [mode, setMode] = useState<OrchestrationMode>('AUTO');
  const [cwd, setCwd] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setGlobalMode('IMPLEMENTATION');
      setMode('AUTO');
      setCwd('');
      setShowPicker(false);
      setError(null);
    }
  }, [open]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const created = await createRun({
        mode,
        globalMode,
        cwd: cwd.trim() || undefined,
      });
      setRun(created);
      selectNode(null);
      selectEdge(null);
      onSuccess(created);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create run';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay">
      <div className="modal new-run-modal">
        <header className="modal__header">
          <h2 className="modal__title">New Session</h2>
          <button className="modal__close" onClick={onClose} type="button">
            ×
          </button>
        </header>

        <form onSubmit={handleSubmit} className="modal__content">
          {error && <div className="modal__error">{error}</div>}

          <div className="form-group">
            <label className="form-label">Global Mode</label>
            <div className="mode-toggle">
              <button
                type="button"
                className={`mode-btn ${globalMode === 'PLANNING' ? 'mode-btn--active' : ''}`}
                onClick={() => setGlobalMode('PLANNING')}
              >
                <Network width={20} height={20} />
                <div className="mode-btn__content">
                  <span className="mode-btn__title">Planning</span>
                  <span className="mode-btn__desc">Research and architectural design</span>
                </div>
              </button>
              <button
                type="button"
                className={`mode-btn ${globalMode === 'IMPLEMENTATION' ? 'mode-btn--active' : ''}`}
                onClick={() => setGlobalMode('IMPLEMENTATION')}
              >
                <Code width={20} height={20} />
                <div className="mode-btn__content">
                  <span className="mode-btn__title">Implementation</span>
                  <span className="mode-btn__desc">Coding and execution</span>
                </div>
              </button>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Orchestration Mode</label>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'AUTO'}
                  onChange={() => setMode('AUTO')}
                />
                <span className="radio-text">
                  <strong>Auto</strong> - Agents run autonomously
                </span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'INTERACTIVE'}
                  onChange={() => setMode('INTERACTIVE')}
                />
                <span className="radio-text">
                  <strong>Interactive</strong> - Guided execution
                </span>
              </label>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Working Directory <span className="form-label-opt">(Optional)</span></label>
            <div className="form-row">
              <input
                type="text"
                className="form-input"
                placeholder="Absolute path to working directory..."
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
              <button
                type="button"
                className={`form-btn-icon ${showPicker ? 'form-btn-icon--active' : ''}`}
                onClick={() => setShowPicker(!showPicker)}
                title="Browse folders"
              >
                <Folder width={16} height={16} />
              </button>
            </div>
            {showPicker && (
              <div className="form-picker">
                <FolderPicker
                  initialPath={cwd}
                  onSelect={(path) => setCwd(path)}
                />
              </div>
            )}
            <p className="form-hint">
              Defaults to project root. Agents will have read/write access here.
            </p>
          </div>

          <div className="modal__actions">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Creating...' : <><Plus width={16} height={16} /> Create Session</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
