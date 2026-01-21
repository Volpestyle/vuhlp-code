import { useEffect, useState, useCallback } from 'react';
import type { TemplateInfo } from '@vuhlp/contracts';
import {
  listTemplates,
  getRoleTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from '../lib/api';
import { Plus, Trash, EditPencil, Check, Xmark, Page } from 'iconoir-react';
import './TemplatesModal.css';

interface TemplatesModalProps {
  open: boolean;
  onClose: () => void;
}

type ViewMode = 'list' | 'create' | 'edit';

export function TemplatesModal({ open, onClose }: TemplatesModalProps) {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateInfo | null>(null);
  const [editContent, setEditContent] = useState('');
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listTemplates();
      setTemplates(result.templates);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load templates';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadTemplates();
      setViewMode('list');
      setSelectedTemplate(null);
      setEditContent('');
      setNewName('');
      setNewContent('');
    }
  }, [open, loadTemplates]);

  const handleSelectTemplate = async (template: TemplateInfo) => {
    setSelectedTemplate(template);
    setError(null);
    try {
      const result = await getRoleTemplate(template.name);
      setEditContent(result.content);
      setViewMode('edit');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load template';
      setError(message);
    }
  };

  const handleCreateNew = () => {
    setViewMode('create');
    setNewName('');
    setNewContent(DEFAULT_TEMPLATE_CONTENT);
    setError(null);
  };

  const handleSaveNew = async () => {
    if (!newName.trim()) {
      setError('Template name is required');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await createTemplate(newName.trim(), newContent);
      await loadTemplates();
      setViewMode('list');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create template';
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!selectedTemplate) return;
    setIsSaving(true);
    setError(null);
    try {
      await updateTemplate(selectedTemplate.name, editContent);
      await loadTemplates();
      setViewMode('list');
      setSelectedTemplate(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update template';
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (template: TemplateInfo) => {
    if (template.source !== 'repo') {
      setError('Cannot delete system templates');
      return;
    }
    if (!confirm(`Delete template "${template.name}"?`)) {
      return;
    }
    setError(null);
    try {
      await deleteTemplate(template.name);
      await loadTemplates();
      if (selectedTemplate?.name === template.name) {
        setViewMode('list');
        setSelectedTemplate(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete template';
      setError(message);
    }
  };

  const handleBack = () => {
    setViewMode('list');
    setSelectedTemplate(null);
    setError(null);
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal templates-modal">
        <header className="modal__header">
          <h2 className="modal__title">
            {viewMode === 'list' && 'Templates'}
            {viewMode === 'create' && 'New Template'}
            {viewMode === 'edit' && `Edit: ${selectedTemplate?.name}`}
          </h2>
          <button className="modal__close" onClick={onClose} type="button">
            ×
          </button>
        </header>

        <div className="modal__content">
          {error && <div className="modal__error">{error}</div>}

          {viewMode === 'list' && (
            <>
              <div className="templates-actions">
                <button
                  className="btn btn--primary btn--sm"
                  onClick={handleCreateNew}
                >
                  <Plus width={14} height={14} /> New Template
                </button>
              </div>

              {loading ? (
                <div className="templates-loading">Loading templates...</div>
              ) : templates.length === 0 ? (
                <div className="templates-empty">No templates found</div>
              ) : (
                <ul className="templates-list">
                  {templates.map((template) => (
                    <li key={`${template.source}-${template.name}`} className="template-item">
                      <button
                        className="template-item__main"
                        onClick={() => handleSelectTemplate(template)}
                      >
                        <Page width={16} height={16} />
                        <span className="template-item__name">{template.name}</span>
                        <span className={`template-item__source template-item__source--${template.source}`}>
                          {template.source}
                        </span>
                      </button>
                      {template.source === 'repo' && (
                        <button
                          className="template-item__delete"
                          onClick={() => handleDelete(template)}
                          title="Delete template"
                        >
                          <Trash width={14} height={14} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {viewMode === 'create' && (
            <>
              <div className="form-group">
                <label className="form-label">Name</label>
                <input
                  className="form-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="my-template"
                  autoFocus
                />
                <p className="form-hint">Alphanumeric, underscore, and hyphen only</p>
              </div>
              <div className="form-group">
                <label className="form-label">Content</label>
                <textarea
                  className="form-textarea templates-editor"
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="Template content..."
                />
              </div>
              <div className="modal__actions">
                <button
                  className="btn btn--secondary"
                  onClick={handleBack}
                  disabled={isSaving}
                >
                  <Xmark width={14} height={14} /> Cancel
                </button>
                <button
                  className="btn btn--primary"
                  onClick={handleSaveNew}
                  disabled={isSaving || !newName.trim()}
                >
                  {isSaving ? 'Saving...' : <><Check width={14} height={14} /> Create</>}
                </button>
              </div>
            </>
          )}

          {viewMode === 'edit' && selectedTemplate && (
            <>
              <div className="form-group">
                <label className="form-label">
                  Content
                  {selectedTemplate.source === 'system' && (
                    <span className="form-label-hint">Editing will create a repo override</span>
                  )}
                </label>
                <textarea
                  className="form-textarea templates-editor"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
              </div>
              <div className="modal__actions">
                <button
                  className="btn btn--secondary"
                  onClick={handleBack}
                  disabled={isSaving}
                >
                  <Xmark width={14} height={14} /> Cancel
                </button>
                <button
                  className="btn btn--primary"
                  onClick={handleSaveEdit}
                  disabled={isSaving}
                >
                  {isSaving ? 'Saving...' : <><EditPencil width={14} height={14} /> Save</>}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const DEFAULT_TEMPLATE_CONTENT = `[template]
name = "my-template"
version = "1"
capabilities = []
constraints = []

# My Template

> **Usage**: Describe when to use this template.

## Identity
- Describe the agent's identity and behavior.

## Responsibilities
- List the agent's responsibilities.

## Constraints
- List what the agent must not do.
`;
