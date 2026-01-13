import { useState } from 'react';
import type { PendingPrompt } from '../../types';
import { Button } from '../Button';
import './PromptQueue.css';

export interface PromptQueueProps {
  prompts: PendingPrompt[];
  runId: string;
  onSendPrompt: (promptId: string) => void;
  onCancelPrompt: (promptId: string) => void;
  onEditPrompt: (promptId: string, newContent: string) => void;
  onCreatePrompt: (content: string, targetNodeId?: string) => void;
  className?: string;
}

export function PromptQueue({
  prompts,
  runId: _runId,
  onSendPrompt,
  onCancelPrompt,
  onEditPrompt,
  onCreatePrompt,
  className = '',
}: PromptQueueProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [newPromptContent, setNewPromptContent] = useState('');
  const [showNewPrompt, setShowNewPrompt] = useState(false);

  const pendingPrompts = prompts.filter((p) => p.status === 'pending');

  const handleStartEdit = (prompt: PendingPrompt) => {
    setEditingId(prompt.id);
    setEditContent(prompt.content);
  };

  const handleSaveEdit = (promptId: string) => {
    if (editContent.trim()) {
      onEditPrompt(promptId, editContent.trim());
    }
    setEditingId(null);
    setEditContent('');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditContent('');
  };

  const handleCreatePrompt = () => {
    if (newPromptContent.trim()) {
      onCreatePrompt(newPromptContent.trim());
      setNewPromptContent('');
      setShowNewPrompt(false);
    }
  };

  if (pendingPrompts.length === 0 && !showNewPrompt) {
    return (
      <div className={`vuhlp-prompt-queue vuhlp-prompt-queue--empty ${className}`}>
        <Button variant="secondary" size="sm" onClick={() => setShowNewPrompt(true)}>
          Add Prompt
        </Button>
      </div>
    );
  }

  return (
    <div className={`vuhlp-prompt-queue ${className}`}>
      <div className="vuhlp-prompt-queue__header">
        <span className="vuhlp-prompt-queue__title">
          Prompt Queue
          {pendingPrompts.length > 0 && (
            <span className="vuhlp-prompt-queue__count">{pendingPrompts.length}</span>
          )}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setShowNewPrompt(!showNewPrompt)}>
          {showNewPrompt ? 'Cancel' : 'Add'}
        </Button>
      </div>

      {/* New Prompt Form */}
      {showNewPrompt && (
        <div className="vuhlp-prompt-queue__new">
          <textarea
            value={newPromptContent}
            onChange={(e) => setNewPromptContent(e.target.value)}
            placeholder="Enter your prompt..."
            className="vuhlp-prompt-queue__textarea"
            rows={3}
            autoFocus
          />
          <div className="vuhlp-prompt-queue__new-actions">
            <Button variant="secondary" size="sm" onClick={() => setShowNewPrompt(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleCreatePrompt}
              disabled={!newPromptContent.trim()}
            >
              Add to Queue
            </Button>
          </div>
        </div>
      )}

      {/* Prompt List */}
      <div className="vuhlp-prompt-queue__list">
        {pendingPrompts.map((prompt, index) => (
          <div key={prompt.id} className="vuhlp-prompt-queue__item">
            <div className="vuhlp-prompt-queue__item-header">
              <span className="vuhlp-prompt-queue__item-index">#{index + 1}</span>
              <span className={`vuhlp-prompt-queue__item-origin vuhlp-prompt-queue__item-origin--${prompt.origin}`}>
                {prompt.origin}
              </span>
              {prompt.targetNodeId && (
                <span className="vuhlp-prompt-queue__item-target">
                  {prompt.targetNodeId.slice(0, 8)}
                </span>
              )}
            </div>

            {editingId === prompt.id ? (
              <div className="vuhlp-prompt-queue__item-edit">
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="vuhlp-prompt-queue__textarea"
                  rows={3}
                  autoFocus
                />
                <div className="vuhlp-prompt-queue__item-edit-actions">
                  <Button variant="ghost" size="sm" onClick={handleCancelEdit}>
                    Cancel
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => handleSaveEdit(prompt.id)}>
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="vuhlp-prompt-queue__item-content">{prompt.content}</div>
                <div className="vuhlp-prompt-queue__item-actions">
                  <Button variant="ghost" size="sm" onClick={() => onCancelPrompt(prompt.id)}>
                    Cancel
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => handleStartEdit(prompt)}>
                    Edit
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => onSendPrompt(prompt.id)}>
                    Send Now
                  </Button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {pendingPrompts.length > 1 && (
        <div className="vuhlp-prompt-queue__footer">
          <span className="vuhlp-prompt-queue__footer-hint">
            Prompts will be sent in order when switching to AUTO mode
          </span>
        </div>
      )}
    </div>
  );
}
