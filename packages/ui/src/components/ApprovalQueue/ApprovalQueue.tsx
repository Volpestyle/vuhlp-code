import { useState } from 'react';
import type { ApprovalRequest } from '../../types';
import { Button } from '../Button';
import './ApprovalQueue.css';

export interface ApprovalQueueProps {
  approvals: ApprovalRequest[];
  onApprove: (id: string, feedback?: string) => void;
  onDeny: (id: string, feedback?: string) => void;
  onModify: (id: string, modifiedArgs: Record<string, unknown>, feedback?: string) => void;
}

export function ApprovalQueue({
  approvals,
  onApprove,
  onDeny,
  onModify,
}: ApprovalQueueProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [editingArgs, setEditingArgs] = useState<string>('');
  const [argsError, setArgsError] = useState<string | null>(null);

  if (approvals.length === 0) return null;

  const handleExpand = (approval: ApprovalRequest) => {
    if (expandedId === approval.id) {
      setExpandedId(null);
    } else {
      setExpandedId(approval.id);
      setFeedback('');
      setEditingArgs(JSON.stringify(approval.args, null, 2));
      setArgsError(null);
    }
  };

  const handleApprove = (id: string) => {
    onApprove(id, feedback || undefined);
    setExpandedId(null);
    setFeedback('');
  };

  const handleDeny = (id: string) => {
    onDeny(id, feedback || undefined);
    setExpandedId(null);
    setFeedback('');
  };

  const handleModify = (id: string) => {
    try {
      const parsedArgs = JSON.parse(editingArgs);
      onModify(id, parsedArgs, feedback || undefined);
      setExpandedId(null);
      setFeedback('');
      setArgsError(null);
    } catch {
      setArgsError('Invalid JSON');
    }
  };

  return (
    <div className="vuhlp-approval-queue">
      <div className="vuhlp-approval-queue__header">
        <span className="vuhlp-approval-queue__title">
          Pending Approvals
          <span className="vuhlp-approval-queue__count">{approvals.length}</span>
        </span>
      </div>

      <div className="vuhlp-approval-queue__list">
        {approvals.map((approval) => (
          <div
            key={approval.id}
            className={`vuhlp-approval-queue__item ${expandedId === approval.id ? 'vuhlp-approval-queue__item--expanded' : ''}`}
          >
            <button
              className="vuhlp-approval-queue__item-header"
              onClick={() => handleExpand(approval)}
            >
              <span className={`vuhlp-approval-queue__risk vuhlp-approval-queue__risk--${approval.riskLevel}`}>
                {approval.riskLevel}
              </span>
              <span className="vuhlp-approval-queue__tool-name">{approval.toolName}</span>
              <span className="vuhlp-approval-queue__node-id">{approval.nodeId.slice(0, 8)}</span>
              <svg
                className={`vuhlp-approval-queue__chevron ${expandedId === approval.id ? 'vuhlp-approval-queue__chevron--open' : ''}`}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {expandedId === approval.id && (
              <div className="vuhlp-approval-queue__item-content">
                {approval.description && (
                  <div className="vuhlp-approval-queue__description">
                    {approval.description}
                  </div>
                )}

                <div className="vuhlp-approval-queue__section">
                  <label className="vuhlp-approval-queue__label">Arguments</label>
                  <textarea
                    value={editingArgs}
                    onChange={(e) => {
                      setEditingArgs(e.target.value);
                      setArgsError(null);
                    }}
                    className="vuhlp-approval-queue__args-textarea"
                    rows={6}
                  />
                  {argsError && (
                    <span className="vuhlp-approval-queue__error">{argsError}</span>
                  )}
                </div>

                <div className="vuhlp-approval-queue__section">
                  <label className="vuhlp-approval-queue__label">Feedback (optional)</label>
                  <input
                    type="text"
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="Add context for the agent..."
                    className="vuhlp-approval-queue__feedback-input"
                  />
                </div>

                <div className="vuhlp-approval-queue__actions">
                  <Button variant="danger" size="sm" onClick={() => handleDeny(approval.id)}>
                    Deny
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => handleModify(approval.id)}>
                    Modify & Approve
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => handleApprove(approval.id)}>
                    Approve
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
