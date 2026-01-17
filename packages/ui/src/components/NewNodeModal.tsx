import { useEffect, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import type { ProviderName, NodeCapabilities, NodePermissions } from '@vuhlp/contracts';
import { useRunStore } from '../stores/runStore';
import { createNode } from '../lib/api';
import { Xmark, Plus } from 'iconoir-react';
import './NewNodeModal.css';

const PROVIDER_OPTIONS: ProviderName[] = ['claude', 'codex', 'gemini', 'custom'];
const PERMISSIONS_MODE_OPTIONS: Array<NodePermissions['cliPermissionsMode']> = ['skip', 'gated'];

const DEFAULT_CAPABILITIES: NodeCapabilities = {
  spawnNodes: false,
  writeCode: true,
  writeDocs: true,
  runCommands: true,
  delegateOnly: false,
};

const DEFAULT_PERMISSIONS: NodePermissions = {
  cliPermissionsMode: 'skip',
  spawnRequiresApproval: true,
};

interface NewNodeModalProps {
  open: boolean;
  onClose: () => void;
}

export function NewNodeModal({ open, onClose }: NewNodeModalProps) {
  const run = useRunStore((s) => s.run);
  const addNode = useRunStore((s) => s.addNode);
  const selectNode = useRunStore((s) => s.selectNode);
  const nodeCount = run ? Object.keys(run.nodes).length : 0;
  const [label, setLabel] = useState('');
  const [roleTemplate, setRoleTemplate] = useState('implementer');
  const [provider, setProvider] = useState<ProviderName>('claude');
  const [capabilities, setCapabilities] = useState<NodeCapabilities>(DEFAULT_CAPABILITIES);
  const [permissions, setPermissions] = useState<NodePermissions>(DEFAULT_PERMISSIONS);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(`New Node ${nodeCount + 1}`);
    setRoleTemplate('implementer');
    setProvider('claude');
    setCapabilities(DEFAULT_CAPABILITIES);
    setPermissions(DEFAULT_PERMISSIONS);
    setError(null);
  }, [open, nodeCount]);

  if (!open) return null;

  const canSubmit = Boolean(run) && label.trim().length > 0 && !isSubmitting;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!run) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const created = await createNode(run.id, {
        label: label.trim(),
        roleTemplate: roleTemplate.trim() || 'implementer',
        provider,
        capabilities,
        permissions,
        session: {
          resume: true,
          resetCommands: ['/new', '/clear'],
        },
      });
      addNode(created);
      selectNode(created.id);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create node';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="new-node-modal__backdrop" onClick={handleBackdropClick} role="presentation">
      <div className="new-node-modal" role="dialog" aria-modal="true" aria-labelledby="new-node-title">
        <header className="new-node-modal__header">
          <h2 className="new-node-modal__title" id="new-node-title">
            New Node
          </h2>
          <button
            className="new-node-modal__close"
            type="button"
            onClick={onClose}
            aria-label="Close"
          >
            <Xmark width={20} height={20} />
          </button>
        </header>

        <form className="new-node-modal__form" onSubmit={handleSubmit}>
          <label className="new-node-modal__field">
            <span className="new-node-modal__label">Label</span>
            <input
              className="new-node-modal__input"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              autoFocus
              placeholder="Node label"
            />
          </label>

          <label className="new-node-modal__field">
            <span className="new-node-modal__label">Role Template</span>
            <input
              className="new-node-modal__input"
              value={roleTemplate}
              onChange={(event) => setRoleTemplate(event.target.value)}
              placeholder="implementer"
            />
          </label>

          <label className="new-node-modal__field">
            <span className="new-node-modal__label">Provider</span>
            <select
              className="new-node-modal__select"
              value={provider}
              onChange={(event) => setProvider(event.target.value as ProviderName)}
            >
              {PROVIDER_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option.toUpperCase()}
                </option>
              ))}
            </select>
          </label>

          <div className="new-node-modal__section">
            <span className="new-node-modal__section-title">Permissions</span>
            <label className="new-node-modal__toggle">
              <input
                type="checkbox"
                checked={permissions.spawnRequiresApproval}
                onChange={() =>
                  setPermissions((prev) => ({
                    ...prev,
                    spawnRequiresApproval: !prev.spawnRequiresApproval,
                  }))
                }
                disabled={isSubmitting}
              />
              <span>Spawn requires approval</span>
            </label>
            <label className="new-node-modal__field">
              <span className="new-node-modal__label">CLI Permissions</span>
              <select
                className="new-node-modal__select"
                value={permissions.cliPermissionsMode}
                onChange={(event) =>
                  setPermissions((prev) => ({
                    ...prev,
                    cliPermissionsMode: event.target.value as NodePermissions['cliPermissionsMode'],
                  }))
                }
                disabled={isSubmitting}
              >
                {PERMISSIONS_MODE_OPTIONS.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="new-node-modal__section">
            <span className="new-node-modal__section-title">Capabilities</span>
            {Object.entries(capabilities).map(([key, value]) => (
              <label key={key} className="new-node-modal__toggle">
                <input
                  type="checkbox"
                  checked={value}
                  onChange={() =>
                    setCapabilities((prev) => ({
                      ...prev,
                      [key]: !prev[key as keyof NodeCapabilities],
                    }))
                  }
                  disabled={isSubmitting}
                />
                <span>{key.replace(/([A-Z])/g, ' $1').trim()}</span>
              </label>
            ))}
          </div>

          {error && <div className="new-node-modal__error">{error}</div>}
          {!run && (
            <div className="new-node-modal__error">Run not ready. Try again in a moment.</div>
          )}

          <div className="new-node-modal__actions">
            <button
              className="new-node-modal__button new-node-modal__button--ghost"
              type="button"
              onClick={onClose}
              title="Cancel"
            >
              <Xmark width={16} height={16} />
            </button>
            <button
              className="new-node-modal__button new-node-modal__button--primary"
              type="submit"
              disabled={!canSubmit}
              title="Create"
            >
              {isSubmitting ? 'Creating...' : <Plus width={16} height={16} />}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
