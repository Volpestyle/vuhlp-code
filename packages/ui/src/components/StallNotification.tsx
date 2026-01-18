/**
 * Stall Notification component
 * Displays when a run is stalled with evidence and suggested actions
 */

import { createPortal } from 'react-dom';
import { useState, useCallback, useRef, useEffect } from 'react';
import { useRunStore } from '../stores/runStore';
import { Xmark, Play } from 'iconoir-react';
import './StallNotification.css';

export function StallNotification() {
  const stall = useRunStore((s) => s.stall);
  const clearStall = useRunStore((s) => s.clearStall);
  const updateRunStatus = useRunStore((s) => s.updateRunStatus);

  // Drag state
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; initialX: number; initialY: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only drag from header, not buttons
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

  const style = position
    ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' }
    : undefined;

  return createPortal(
    <div className={`stall-notification ${position ? 'stall-notification--dragged' : ''}`} style={style}>
      <div className="stall-notification__header stall-notification__header--draggable" onMouseDown={handleMouseDown}>
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
          className="stall-notification__btn stall-notification__btn--primary"
          onClick={handleResume}
          title="Resume Run"
        >
          <Play width={14} height={14} />
        </button>
      </div>
    </div>,
    document.body
  );
}
