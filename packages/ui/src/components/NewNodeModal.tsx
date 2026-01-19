import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ProviderName, NodeCapabilities, NodePermissions } from '@vuhlp/contracts';
import { useRunStore } from '../stores/runStore';
import { createNode } from '../lib/api';
import { Plus } from 'iconoir-react';
import './NewNodeModal.css';

const PROVIDER_OPTIONS: ProviderName[] = ['claude', 'codex', 'gemini', 'custom'];
const PERMISSIONS_MODE_OPTIONS: Array<NodePermissions['cliPermissionsMode']> = ['skip', 'gated'];
const ORCHESTRATOR_ROLE = 'orchestrator';

const DEFAULT_CAPABILITIES: NodeCapabilities = {
  spawnNodes: false,
  writeCode: true,
  writeDocs: true,
  runCommands: true,
  delegateOnly: false,
};

const DEFAULT_PERMISSIONS: NodePermissions = {
  cliPermissionsMode: 'skip',
  agentManagementRequiresApproval: true,
};

const getSpawnDefaults = (roleTemplate: string) => {
  const isOrchestrator = roleTemplate.trim().toLowerCase() === ORCHESTRATOR_ROLE;
  return {
    spawnNodes: isOrchestrator,
    agentManagementRequiresApproval: !isOrchestrator,
  };
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
  const [spawnNodesTouched, setSpawnNodesTouched] = useState(false);
  const [agentManagementApprovalTouched, setAgentManagementApprovalTouched] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(`New Node ${nodeCount + 1}`);
    setRoleTemplate('implementer');
    setProvider('claude');
    setCapabilities(DEFAULT_CAPABILITIES);
    setPermissions(DEFAULT_PERMISSIONS);
    setSpawnNodesTouched(false);
    setAgentManagementApprovalTouched(false);
    setError(null);
  }, [open, nodeCount]);

  useEffect(() => {
    if (!open) return;
    const defaults = getSpawnDefaults(roleTemplate);
    if (!spawnNodesTouched) {
      setCapabilities((prev) => ({ ...prev, spawnNodes: defaults.spawnNodes }));
    }
    if (!agentManagementApprovalTouched) {
      setPermissions((prev) => ({
        ...prev,
        agentManagementRequiresApproval: defaults.agentManagementRequiresApproval,
      }));
    }
  }, [open, roleTemplate, spawnNodesTouched, agentManagementApprovalTouched]);

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

  return (
    <div className="new-node-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="new-node-modal" role="dialog" aria-modal="true" aria-labelledby="new-node-title">
        <header className="new-node-modal__header">
          <h2 className="new-node-modal__title" id="new-node-title">
            New Node
          </h2>
          <button className="new-node-modal__close" onClick={onClose} type="button">
            &times;
          </button>
        </header>

        <form onSubmit={handleSubmit} className="new-node-modal__content">
          {error && <div className="new-node-modal__error">{error}</div>}
          {!run && <div className="new-node-modal__error">Run not ready. Try again in a moment.</div>}

          <div className="form-group">
            <label className="form-label">Label</label>
            <input
              className="form-input"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              autoFocus
              placeholder="Node label"
            />
          </div>

          <div className="form-group">
            <label className="form-label">Role Template</label>
            <input
              className="form-input"
              value={roleTemplate}
              onChange={(event) => setRoleTemplate(event.target.value)}
              placeholder="implementer"
            />
          </div>

          <div className="form-group">
            <label className="form-label">Provider</label>
            <select
              className="form-select"
              value={provider}
              onChange={(event) => setProvider(event.target.value as ProviderName)}
            >
              {PROVIDER_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          <div className="new-node-modal__section">
            <span className="new-node-modal__section-title">Permissions</span>
            <label className="new-node-modal__toggle">
              <input
                type="checkbox"
                checked={permissions.agentManagementRequiresApproval}
                onChange={() =>
                  setPermissions((prev) => {
                    setAgentManagementApprovalTouched(true);
                    return {
                      ...prev,
                      agentManagementRequiresApproval: !prev.agentManagementRequiresApproval,
                    };
                  })
                }
                disabled={isSubmitting}
              />
              <span>Agent management requires approval</span>
            </label>
            <div className="form-group">
              <label className="form-label">CLI Permissions</label>
              <select
                className="form-select"
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
            </div>
          </div>

          <div className="new-node-modal__section">
            <span className="new-node-modal__section-title">Capabilities</span>
            {Object.entries(capabilities).map(([key, value]) => (
              <label key={key} className="new-node-modal__toggle">
                <input
                  type="checkbox"
                  checked={value}
                  onChange={() =>
                    setCapabilities((prev) => {
                      if (key === 'spawnNodes') {
                        setSpawnNodesTouched(true);
                      }
                      return {
                        ...prev,
                        [key]: !prev[key as keyof NodeCapabilities],
                      };
                    })
                  }
                  disabled={isSubmitting}
                />
                <span>{key.replace(/([A-Z])/g, ' $1').trim()}</span>
              </label>
            ))}
          </div>

          <div className="new-node-modal__actions">
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
              disabled={!canSubmit}
            >
              {isSubmitting ? 'Creating...' : <><Plus width={16} height={16} /> Create Node</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
