/**
 * Approval Queue component
 * Displays pending approval requests for user action
 */

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

  return (
    <div className="approval-queue">
      <div className="approval-queue__header">
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
    </div>
  );
}
