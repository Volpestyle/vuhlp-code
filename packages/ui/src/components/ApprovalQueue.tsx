/**
 * Approval Queue component
 * Displays pending approval requests for user action
 */

import { createPortal } from 'react-dom';
import { useState, useCallback, useRef, useEffect } from 'react';
import type { ApprovalRequest } from '@vuhlp/contracts';
import { useRunStore } from '../stores/runStore';
import { resolveApproval } from '../lib/api';
import { Check, Xmark } from 'iconoir-react';
import './ApprovalQueue.css';

interface ApprovalQueueProps {
  approvals: ApprovalRequest[];
}

export function ApprovalQueue({ approvals }: ApprovalQueueProps) {
  const removeApproval = useRunStore((s) => s.removeApproval);
  const run = useRunStore((s) => s.run);

  // Drag state
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; initialX: number; initialY: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;

    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialX: position?.x ?? rect.left,
      initialY: position?.y ?? rect.top,
    };
    e.preventDefault();
  }, [position]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPosition({
        x: dragRef.current.initialX + dx,
        y: dragRef.current.initialY + dy,
      });
    };

    const handleMouseUp = () => {
      dragRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleApprove = (approval: ApprovalRequest) => {
    void resolveApproval(approval.approvalId, { status: 'approved' })
      .then(() => removeApproval(approval.approvalId))
      .catch((error) => {
        console.error('[approval] failed to approve', error);
      });
  };

  const handleDeny = (approval: ApprovalRequest) => {
    void resolveApproval(approval.approvalId, { status: 'denied' })
      .then(() => removeApproval(approval.approvalId))
      .catch((error) => {
        console.error('[approval] failed to deny', error);
      });
  };

  const getNodeLabel = (nodeId: string): string => {
    return run?.nodes[nodeId]?.label ?? nodeId;
  };

  if (approvals.length === 0) return null;

  const style = position
    ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' }
    : undefined;

  return createPortal(
    <div className={`approval-queue ${position ? 'approval-queue--dragged' : ''}`} style={style}>
      <div className="approval-queue__header approval-queue__header--draggable" onMouseDown={handleMouseDown}>
        <span className="approval-queue__count">{approvals.length}</span>
        <span className="approval-queue__title">Pending Approvals</span>
      </div>
      <div className="approval-queue__list">
        {approvals.map((approval) => (
          <div key={approval.approvalId} className="approval-queue__item">
            <div className="approval-queue__item-header">
              <span className="approval-queue__node">{getNodeLabel(approval.nodeId)}</span>
              <span className="approval-queue__tool-name">{approval.tool.name}</span>
            </div>
            {approval.context && (
              <p className="approval-queue__context">{approval.context}</p>
            )}
            <div className="approval-queue__args">
              <pre className="approval-queue__args-code">
                {JSON.stringify(approval.tool.args, null, 2)}
              </pre>
            </div>
            <div className="approval-queue__actions">
              <button
                className="approval-queue__btn approval-queue__btn--deny"
                onClick={() => handleDeny(approval)}
                title="Deny"
              >
                <Xmark width={16} height={16} />
              </button>
              <button
                className="approval-queue__btn approval-queue__btn--approve"
                onClick={() => handleApprove(approval)}
                title="Approve"
              >
                <Check width={16} height={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
}
