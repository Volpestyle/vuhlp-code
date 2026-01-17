/**
 * Stall Notification component
 * Displays when a run is stalled with evidence and suggested actions
 */

import { useRunStore } from '../stores/runStore';
import { Xmark, Play } from 'iconoir-react';
import './StallNotification.css';

export function StallNotification() {
  const stall = useRunStore((s) => s.stall);
  const clearStall = useRunStore((s) => s.clearStall);
  const updateRunStatus = useRunStore((s) => s.updateRunStatus);

  if (!stall.isStalled || !stall.evidence) {
    return null;
  }

  const handleResume = () => {
    clearStall();
    updateRunStatus('running');
    console.log('[stall] user resumed run');
  };

  const handleDismiss = () => {
    clearStall();
    console.log('[stall] user dismissed notification');
  };

  return (
    <div className="stall-notification">
      <div className="stall-notification__header">
        <span className="stall-notification__icon">&#9888;</span>
        <span className="stall-notification__title">Run Stalled</span>
        <button
          className="stall-notification__close"
          onClick={handleDismiss}
          aria-label="Dismiss"
        >
          <Xmark width={16} height={16} />
        </button>
      </div>

      <div className="stall-notification__content">
        <p className="stall-notification__message">
          The orchestration has been paused due to detected stall conditions.
        </p>

        {/* Evidence Section */}
        <div className="stall-notification__evidence">
          <h4 className="stall-notification__evidence-title">Evidence</h4>

          {stall.evidence.outputHash && (
            <div className="stall-notification__evidence-item">
              <span className="stall-notification__evidence-label">Repeated Output Hash:</span>
              <code className="stall-notification__evidence-value">{stall.evidence.outputHash.slice(0, 16)}...</code>
            </div>
          )}

          {stall.evidence.diffHash && (
            <div className="stall-notification__evidence-item">
              <span className="stall-notification__evidence-label">Repeated Diff Hash:</span>
              <code className="stall-notification__evidence-value">{stall.evidence.diffHash.slice(0, 16)}...</code>
            </div>
          )}

          {stall.evidence.verificationFailure && (
            <div className="stall-notification__evidence-item">
              <span className="stall-notification__evidence-label">Verification Failure:</span>
              <span className="stall-notification__evidence-value stall-notification__evidence-value--error">
                {stall.evidence.verificationFailure}
              </span>
            </div>
          )}

          {stall.evidence.summaries.length > 0 && (
            <div className="stall-notification__summaries">
              <span className="stall-notification__evidence-label">Recent Summaries:</span>
              <ul className="stall-notification__summary-list">
                {stall.evidence.summaries.map((summary, i) => (
                  <li key={i} className="stall-notification__summary-item">{summary}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Suggested Actions */}
        <div className="stall-notification__suggestions">
          <h4 className="stall-notification__suggestions-title">Suggested Actions</h4>
          <ul className="stall-notification__suggestion-list">
            <li>Adjust the orchestrator prompt to provide clearer direction</li>
            <li>Reset the context for the stalled node</li>
            <li>Check if the task requirements are achievable</li>
          </ul>
        </div>
      </div>

      <div className="stall-notification__actions">
        <button
          className="stall-notification__btn stall-notification__btn--secondary"
          onClick={handleDismiss}
          title="Dismiss"
        >
          <Xmark width={14} height={14} />
        </button>
        <button
          className="stall-notification__btn stall-notification__btn--primary"
          onClick={handleResume}
          title="Resume Run"
        >
          <Play width={14} height={14} />
        </button>
      </div>
    </div>
  );
}
