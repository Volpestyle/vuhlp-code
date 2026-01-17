/**
 * Edge Inspector component
 * Shows details for selected edge.
 */

import { useState } from 'react';
import type { EdgeState } from '@vuhlp/contracts';
import { useRunStore } from '../stores/runStore';
import { createEdge, deleteEdge } from '../lib/api';
import { ArrowRight, ArrowsUpFromLine, Trash } from 'iconoir-react';
import './NodeInspector.css';
import './EdgeInspector.css';

interface EdgeInspectorProps {
  edge: EdgeState;
}

export function EdgeInspector({ edge }: EdgeInspectorProps) {
  const runId = useRunStore((s) => s.run?.id);
  const getNode = useRunStore((s) => s.getNode);
  const addEdge = useRunStore((s) => s.addEdge);
  const removeEdge = useRunStore((s) => s.removeEdge);

  const fromNode = getNode(edge.from);
  const toNode = getNode(edge.to);
  const fromLabel = fromNode?.label ?? edge.from;
  const toLabel = toNode?.label ?? edge.to;

  const handleUpdateEdge = (patch: Partial<EdgeState>) => {
    const updated = { ...edge, ...patch };
    if (!runId) {
      addEdge(updated);
      return;
    }
    void createEdge(runId, {
      id: updated.id,
      from: updated.from,
      to: updated.to,
      bidirectional: updated.bidirectional,
      type: updated.type,
      label: updated.label
    })
      .then((saved) => addEdge(saved))
      .catch((error) => {
        console.error('[edge-inspector] failed to update edge', error);
      });
  };

  const handleDirectionChange = (bidirectional: boolean) => {
    if (edge.bidirectional === bidirectional) return;
    handleUpdateEdge({ bidirectional });
  };

  const handleSaveLabel = (label: string) => {
    handleUpdateEdge({ label });
  };

  const handleDeleteEdge = () => {
    if (!runId) {
      removeEdge(edge.id);
      return;
    }
    void deleteEdge(runId, edge.id)
      .then(() => removeEdge(edge.id))
      .catch((error) => {
        console.error('[edge-inspector] failed to delete edge', error);
      });
  };

  return (
    <div className="inspector edge-inspector">
      <header className="inspector__header">
        <div className="inspector__title-row">
          <h2 className="inspector__title">{edge.label || 'Edge'}</h2>
          <span className="edge-inspector__type">{edge.type?.toUpperCase() ?? 'EDGE'}</span>
        </div>
        <div className="edge-inspector__route">
          <span className="edge-inspector__node">{fromLabel}</span>
          <span className="edge-inspector__arrow">{edge.bidirectional ? '\u2194' : '\u2192'}</span>
          <span className="edge-inspector__node">{toLabel}</span>
        </div>
      </header>

      <div className="inspector__content">
        <div className="inspector__section">
          <div className="inspector__group">
            <h3 className="inspector__group-title">Label</h3>
            <EditableEdgeLabel
              edgeId={edge.id}
              label={edge.label ?? ''}
              onSave={handleSaveLabel}
            />
          </div>

          <div className="inspector__group">
            <h3 className="inspector__group-title">Details</h3>
            <div className="inspector__kv-list">
              <div className="inspector__kv">
                <span className="inspector__kv-key">From</span>
                <span className="inspector__kv-value">{fromLabel}</span>
              </div>
              <div className="inspector__kv">
                <span className="inspector__kv-key">To</span>
                <span className="inspector__kv-value">{toLabel}</span>
              </div>
              <div className="inspector__kv">
                <span className="inspector__kv-key">Direction</span>
                <div className="edge-inspector__direction-toggle" role="group" aria-label="Edge direction">
                  <button
                    className={`edge-inspector__direction-button ${
                      edge.bidirectional ? '' : 'edge-inspector__direction-button--active'
                    }`}
                    type="button"
                    onClick={() => handleDirectionChange(false)}
                    aria-pressed={!edge.bidirectional}
                    title="Directed"
                  >
                    <ArrowRight width={14} height={14} />
                  </button>
                  <button
                    className={`edge-inspector__direction-button ${
                      edge.bidirectional ? 'edge-inspector__direction-button--active' : ''
                    }`}
                    type="button"
                    onClick={() => handleDirectionChange(true)}
                    aria-pressed={edge.bidirectional}
                    title="Bidirectional"
                  >
                    <ArrowsUpFromLine width={14} height={14} />
                  </button>
                </div>
              </div>
              <div className="inspector__kv">
                <span className="inspector__kv-key">Type</span>
                <span className="inspector__kv-value">{edge.type}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <footer className="inspector__footer">
        <div className="inspector__footer-actions">
          <button
            className="inspector__btn inspector__btn--danger"
            onClick={handleDeleteEdge}
            title="Delete edge"
          >
            <Trash width={14} height={14} />
          </button>
        </div>
      </footer>
    </div>
  );
}

function EditableEdgeLabel({
  edgeId,
  label,
  onSave,
}: {
  edgeId: string;
  label: string;
  onSave: (label: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(label ?? '');

  const handleDoubleClick = () => {
    setIsEditing(true);
    setEditValue(label ?? '');
  };

  const handleBlur = () => {
    setIsEditing(false);
    if (editValue.trim() && editValue !== label) {
      onSave(editValue.trim());
      console.log('[edge-label] saved:', { edgeId, from: label, to: editValue.trim() });
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleBlur();
    }
    if (event.key === 'Escape') {
      setIsEditing(false);
      setEditValue(label);
    }
  };

  if (isEditing) {
    return (
      <input
        type="text"
        className="inspector__edge-label-input"
        value={editValue}
        onChange={(event) => setEditValue(event.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        autoFocus
      />
    );
  }

  return (
    <span
      className="inspector__edge-label inspector__edge-label--editable"
      onDoubleClick={handleDoubleClick}
      title="Double-click to edit"
    >
      {label || 'Untitled edge'}
    </span>
  );
}
