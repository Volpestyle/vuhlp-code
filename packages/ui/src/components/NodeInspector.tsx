/**
 * Node Inspector component
 * Shows detailed info for selected node per docs/07-ui-spec.md:
 * - Status and live activity
 * - Prompt log for each turn
 * - Incoming/outgoing handoffs
 * - Diffs produced by the node
 * - Artifacts list with preview
 * - Tool usage events
 * - Connection properties
 * - Controls: interrupt, queue message, reset context
 */

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { NodeState, Artifact, Envelope, EdgeState, ProviderName, NodeCapabilities, NodePermissions } from '@vuhlp/contracts';
import { useRunStore, type ToolEvent, type ChatMessage } from '../stores/runStore';
import { createEdge, deleteEdge, deleteNode, getArtifactContent, postChat, resetNode, updateNode } from '../lib/api';
import { StatusBadge } from './StatusBadge';
import { ProviderBadge } from './ProviderBadge';
import { RefreshDouble, Trash, Check, Eye } from 'iconoir-react';
import './NodeInspector.css';

interface NodeInspectorProps {
  node: NodeState;
}

type InspectorTab = 'overview' | 'chat' | 'handoffs' | 'prompts' | 'transcripts' | 'diffs' | 'artifacts' | 'tools';
const PROVIDER_OPTIONS: ProviderName[] = ['claude', 'codex', 'gemini', 'custom'];
const PERMISSIONS_MODE_OPTIONS: Array<NodePermissions['cliPermissionsMode']> = ['skip', 'gated'];
const ROLE_TEMPLATE_OPTIONS = ['orchestrator', 'planner', 'implementer', 'reviewer', 'investigator'];
const EMPTY_MESSAGES: ChatMessage[] = [];

type NodeConfigDraft = {
  label: string;
  roleTemplate: string;
  customSystemPrompt: string;
  capabilities: NodeCapabilities;
  permissions: NodePermissions;
};

const areCapabilitiesEqual = (a: NodeCapabilities, b: NodeCapabilities) =>
  (Object.keys(a) as Array<keyof NodeCapabilities>).every((key) => a[key] === b[key]);

const arePermissionsEqual = (a: NodePermissions, b: NodePermissions) =>
  a.cliPermissionsMode === b.cliPermissionsMode && a.spawnRequiresApproval === b.spawnRequiresApproval;

export function NodeInspector({ node }: NodeInspectorProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>('overview');
  const [messageInput, setMessageInput] = useState('');
  const [messageError, setMessageError] = useState<string | null>(null);
  const [providerValue, setProviderValue] = useState<ProviderName>(node.provider);
  const [providerSaving, setProviderSaving] = useState(false);
  const [promptOverrideMode, setPromptOverrideMode] = useState<'template' | 'custom'>(
    node.customSystemPrompt ? 'custom' : 'template'
  );
  const [configDraft, setConfigDraft] = useState<NodeConfigDraft>({
    label: node.label,
    roleTemplate: node.roleTemplate,
    customSystemPrompt: node.customSystemPrompt ?? '',
    capabilities: node.capabilities,
    permissions: node.permissions,
  });
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState<Record<string, string>>({});
  const [loadingArtifactId, setLoadingArtifactId] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const getNodeArtifacts = useRunStore((s) => s.getNodeArtifacts);
  const getNodeEdges = useRunStore((s) => s.getNodeEdges);
  const getNodeToolEvents = useRunStore((s) => s.getNodeToolEvents);
  const recentHandoffs = useRunStore((s) => s.recentHandoffs);
  const runId = useRunStore((s) => s.run?.id);
  const removeNode = useRunStore((s) => s.removeNode);
  const removeEdge = useRunStore((s) => s.removeEdge);
  const addEdge = useRunStore((s) => s.addEdge);
  const addChatMessage = useRunStore((s) => s.addChatMessage);
  const messages = useRunStore((s) => s.chatMessages[node.id] ?? EMPTY_MESSAGES);

  const artifacts = getNodeArtifacts(node.id);
  const edges = getNodeEdges(node.id);
  const toolEvents = getNodeToolEvents(node.id);
  const nodeHandoffs = recentHandoffs.filter(
    (h) => h.fromNodeId === node.id || h.toNodeId === node.id
  );
  const diffs = artifacts.filter((a) => a.kind === 'diff');
  const prompts = artifacts
    .filter((a) => a.kind === 'prompt')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const transcripts = artifacts
    .filter((a) => a.kind === 'transcript')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  useEffect(() => {
    setProviderValue(node.provider);
  }, [node.provider]);

  useEffect(() => {
    setConfigDraft({
      label: node.label,
      roleTemplate: node.roleTemplate,
      customSystemPrompt: node.customSystemPrompt ?? '',
      capabilities: node.capabilities,
      permissions: node.permissions,
    });
    setPromptOverrideMode(node.customSystemPrompt ? 'custom' : 'template');
    setConfigError(null);
    setMessageInput('');
    setMessageError(null);
  }, [
    node.id,
    node.label,
    node.roleTemplate,
    node.customSystemPrompt,
    node.capabilities,
    node.permissions,
  ]);

  const roleTemplateOptions = useMemo(() => {
    const options = [...ROLE_TEMPLATE_OPTIONS];
    const current = configDraft.roleTemplate.trim();
    if (current && !options.includes(current)) {
      options.push(current);
    }
    return options;
  }, [configDraft.roleTemplate]);

  const configDirty = useMemo(() => {
    const desiredCustomPrompt =
      promptOverrideMode === 'custom' ? configDraft.customSystemPrompt : null;
    const existingCustomPrompt = node.customSystemPrompt ?? null;
    return (
      configDraft.label !== node.label ||
      configDraft.roleTemplate !== node.roleTemplate ||
      desiredCustomPrompt !== existingCustomPrompt ||
      !areCapabilitiesEqual(configDraft.capabilities, node.capabilities) ||
      !arePermissionsEqual(configDraft.permissions, node.permissions)
    );
  }, [configDraft, node, promptOverrideMode]);

  const labelValid = configDraft.label.trim().length > 0;
  const roleValid = configDraft.roleTemplate.trim().length > 0;
  const customPromptValid =
    promptOverrideMode !== 'custom' || configDraft.customSystemPrompt.trim().length > 0;
  const canSaveConfig =
    Boolean(runId) && !configSaving && configDirty && labelValid && roleValid && customPromptValid;

  const loadArtifact = async (artifactId: string) => {
    if (!runId) {
      console.warn('[inspector] cannot load artifact without active run');
      return;
    }
    if (artifactContent[artifactId]) {
      return;
    }
    setLoadingArtifactId(artifactId);
    setArtifactError(null);
    try {
      const result = await getArtifactContent(runId, artifactId);
      setArtifactContent((prev) => ({ ...prev, [artifactId]: result.content }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setArtifactError(message);
    } finally {
      setLoadingArtifactId(null);
    }
  };

  const handleMessageChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setMessageInput(event.target.value);
    if (messageError) {
      setMessageError(null);
    }
  };

  const handleSendMessage = (interrupt: boolean) => {
    const content = messageInput.trim();
    if (!content) return;
    if (!runId) {
      setMessageError('Start a run to send messages.');
      console.warn('[inspector] cannot send message without active run');
      return;
    }
    const now = new Date().toISOString();
    addChatMessage({
      id: `local-${crypto.randomUUID()}`,
      nodeId: node.id,
      role: 'user',
      content,
      createdAt: now,
    });
    setMessageInput('');
    setMessageError(null);
    void postChat(runId, node.id, content, interrupt).catch((error) => {
      console.error('[inspector] failed to send message', error);
      setMessageError('Failed to send message.');
    });
  };

  const handleProviderChange = (nextProvider: ProviderName) => {
    if (nextProvider === node.provider) {
      setProviderValue(nextProvider);
      return;
    }
    setProviderValue(nextProvider);
    if (!runId) {
      console.warn('[inspector] cannot update provider without active run');
      return;
    }
    const resetCommands = node.session?.resetCommands ?? ['/new', '/clear'];
    setProviderSaving(true);
    void updateNode(
      runId,
      node.id,
      { provider: nextProvider },
      { provider: nextProvider, session: { resume: false, resetCommands } }
    )
      .catch((error) => {
        console.error('[inspector] failed to update provider', error);
        setProviderValue(node.provider);
      })
      .finally(() => setProviderSaving(false));
  };

  const handleConfigChange = (patch: Partial<NodeConfigDraft>) => {
    setConfigDraft((prev) => ({ ...prev, ...patch }));
  };

  const handleCapabilityToggle = (key: keyof NodeCapabilities) => {
    setConfigDraft((prev) => ({
      ...prev,
      capabilities: { ...prev.capabilities, [key]: !prev.capabilities[key] },
    }));
  };

  const handlePermissionsModeChange = (mode: NodePermissions['cliPermissionsMode']) => {
    setConfigDraft((prev) => ({
      ...prev,
      permissions: { ...prev.permissions, cliPermissionsMode: mode },
    }));
  };

  const handleSpawnApprovalToggle = () => {
    setConfigDraft((prev) => ({
      ...prev,
      permissions: {
        ...prev.permissions,
        spawnRequiresApproval: !prev.permissions.spawnRequiresApproval,
      },
    }));
  };

  const handleSaveConfig = () => {
    if (!runId) {
      console.warn('[inspector] cannot update config without active run');
      return;
    }
    const label = configDraft.label.trim();
    const roleTemplate = configDraft.roleTemplate.trim();
    const customSystemPrompt =
      promptOverrideMode === 'custom' ? configDraft.customSystemPrompt : null;
    if (!label || !roleTemplate) {
      setConfigError('Label and role template are required.');
      return;
    }
    if (promptOverrideMode === 'custom' && !configDraft.customSystemPrompt.trim()) {
      setConfigError('Custom prompt is required when prompt override is set to Custom.');
      return;
    }
    setConfigSaving(true);
    setConfigError(null);
    const patch = {
      label,
      roleTemplate,
      customSystemPrompt,
      capabilities: configDraft.capabilities,
      permissions: configDraft.permissions,
    };
    void updateNode(runId, node.id, patch, patch)
      .catch((error) => {
        console.error('[inspector] failed to update config', error);
        setConfigError('Failed to save configuration.');
      })
      .finally(() => setConfigSaving(false));
  };

  const handleResetContext = () => {
    if (!runId) {
      console.warn('[inspector] cannot reset context without active run');
      return;
    }
    void resetNode(runId, node.id).catch((error) => {
      console.error('[inspector] failed to reset context', error);
    });
  };

  const handleDeleteNode = () => {
    if (!runId) {
      console.warn('[inspector] cannot delete node without active run');
      return;
    }
    const confirmed = window.confirm(`Delete node "${node.label}"? This cannot be undone.`);
    if (!confirmed) {
      return;
    }
    void deleteNode(runId, node.id)
      .then(() => removeNode(node.id))
      .catch((error) => {
        console.error('[inspector] failed to delete node', error);
      });
  };

  const handleDeleteEdge = (edgeId: string) => {
    if (!runId) {
      console.warn('[inspector] cannot delete edge without active run');
      return;
    }
    void deleteEdge(runId, edgeId)
      .then(() => removeEdge(edgeId))
      .catch((error) => {
        console.error('[inspector] failed to delete edge', error);
      });
  };

  const handleUpdateEdge = (edge: EdgeState, patch: Partial<EdgeState>) => {
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
        console.error('[inspector] failed to update edge', error);
      });
  };

  const handleSaveEdgeLabel = (edgeId: string, label: string) => {
    const edge = edges.find((item) => item.id === edgeId);
    if (!edge) return;
    handleUpdateEdge(edge, { label });
  };

  const tabs: { id: InspectorTab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'chat', label: 'Chat', count: messages.length },
    { id: 'handoffs', label: 'Handoffs', count: nodeHandoffs.length },
    { id: 'prompts', label: 'Prompts', count: prompts.length },
    { id: 'transcripts', label: 'Transcripts', count: transcripts.length },
    { id: 'diffs', label: 'Diffs', count: diffs.length },
    { id: 'artifacts', label: 'Artifacts', count: artifacts.length },
    { id: 'tools', label: 'Tools', count: toolEvents.length },
  ];

  return (
    <div className="inspector">
      {/* Toolbar */}
      <header className="inspector__header">
        <div className="inspector__title-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <h2 className="inspector__title">{node.label}</h2>
            <StatusBadge status={node.status} />
          </div>
          <div className="inspector__actions">
            <button
              className="inspector__toolbar-btn"
              onClick={handleResetContext}
              title="Reset node context"
            >
              <RefreshDouble width={14} height={14} />
            </button>
            <button
              className="inspector__toolbar-btn inspector__toolbar-btn--danger"
              onClick={handleDeleteNode}
              title="Delete node from run"
            >
              <Trash width={14} height={14} />
            </button>
          </div>
        </div>
        <div className="inspector__meta">
          <div className="inspector__meta-block">
            <span className="inspector__meta-label">Provider</span>
            <div className="inspector__meta-control">
              <ProviderBadge provider={node.provider} size="sm" />
              <select
                className="inspector__provider-select"
                value={providerValue}
                onChange={(event) => handleProviderChange(event.target.value as ProviderName)}
                disabled={providerSaving || !runId}
                title="Switching providers restarts the session"
              >
                {PROVIDER_OPTIONS.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <span className="inspector__meta-note">Switching providers restarts the session.</span>
          </div>
          <div className="inspector__meta-block">
            <span className="inspector__meta-label">Role</span>
            <span className="inspector__role">
              {node.customSystemPrompt ? 'custom' : node.roleTemplate}
            </span>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <nav className="inspector__tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`inspector__tab ${activeTab === tab.id ? 'inspector__tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="inspector__tab-count">{tab.count}</span>
            )}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="inspector__content">
        {activeTab === 'overview' && (
          <OverviewTab
            node={node}
            edges={edges}
            configDraft={configDraft}
            configDirty={configDirty}
            configSaving={configSaving}
            configDisabled={!runId || configSaving}
            configError={configError}
            canSaveConfig={canSaveConfig}
            onConfigChange={handleConfigChange}
            roleTemplateOptions={roleTemplateOptions}
            promptOverrideMode={promptOverrideMode}
            customPromptValid={customPromptValid}
            onPromptOverrideModeChange={setPromptOverrideMode}
            onCapabilityToggle={handleCapabilityToggle}
            onPermissionsModeChange={handlePermissionsModeChange}
            onSpawnApprovalToggle={handleSpawnApprovalToggle}
            onSaveConfig={handleSaveConfig}
            onDeleteEdge={handleDeleteEdge}
            onSaveEdgeLabel={handleSaveEdgeLabel}
          />
        )}
        {activeTab === 'chat' && (
          <ChatTab messages={messages} nodeLabel={node.label} />
        )}
        {activeTab === 'handoffs' && (
          <HandoffsTab handoffs={nodeHandoffs} nodeId={node.id} />
        )}
        {activeTab === 'prompts' && (
          <TextArtifactsTab
            artifacts={prompts}
            emptyLabel="No prompt artifacts yet"
            contentById={artifactContent}
            loadingId={loadingArtifactId}
            onLoad={loadArtifact}
            error={artifactError}
          />
        )}
        {activeTab === 'transcripts' && (
          <TextArtifactsTab
            artifacts={transcripts}
            emptyLabel="No transcripts yet"
            contentById={artifactContent}
            loadingId={loadingArtifactId}
            onLoad={loadArtifact}
            error={artifactError}
          />
        )}
        {activeTab === 'diffs' && (
          <DiffsTab diffs={diffs} />
        )}
        {activeTab === 'artifacts' && (
          <ArtifactsTab artifacts={artifacts} />
        )}
        {activeTab === 'tools' && (
          <ToolsTab toolEvents={toolEvents} />
        )}
      </div>

      {/* Controls */}
      <footer className="inspector__footer">
        <div className="inspector__message-input">
          <textarea
            className="inspector__textarea"
            placeholder="Send message to node..."
            value={messageInput}
            onChange={handleMessageChange}
            rows={2}
          />
          {messageError && <div className="inspector__error">{messageError}</div>}
          <div className="inspector__message-actions">
            <button
              className="inspector__btn inspector__btn--secondary"
              onClick={() => handleSendMessage(false)}
              disabled={!messageInput.trim()}
              title="Queue message for next turn"
            >
              Queue
            </button>
            <button
              className="inspector__btn inspector__btn--primary"
              onClick={() => handleSendMessage(true)}
              disabled={!messageInput.trim()}
              title="Interrupt and send immediately"
            >
              Interrupt
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

function ChatTab({ messages, nodeLabel }: { messages: ChatMessage[]; nodeLabel: string }) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="inspector__empty">
        <span className="inspector__empty-text">Start a conversation with {nodeLabel}</span>
      </div>
    );
  }

  return (
    <div className="inspector__section inspector__chat">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`inspector__chat-message inspector__chat-message--${msg.role} ${msg.streaming ? 'inspector__chat-message--streaming' : ''}`}
        >
          <div className="inspector__chat-header">
            <span className="inspector__chat-role">{msg.role}</span>
            <div className="inspector__chat-meta">
              {msg.streaming && (
                <span className="inspector__chat-streaming">
                  <span className="inspector__chat-streaming-dot" />
                  streaming
                </span>
              )}
              <span className="inspector__chat-time">
                {new Date(msg.createdAt).toLocaleTimeString('en-US', { hour12: false })}
              </span>
            </div>
          </div>
          <div className="inspector__chat-content">{msg.content}</div>
        </div>
      ))}
      <div ref={messagesEndRef} />
    </div>
  );
}

function OverviewTab({
  node,
  edges,
  configDraft,
  configDirty,
  configSaving,
  configDisabled,
  configError,
  canSaveConfig,
  onConfigChange,
  roleTemplateOptions,
  promptOverrideMode,
  customPromptValid,
  onPromptOverrideModeChange,
  onCapabilityToggle,
  onPermissionsModeChange,
  onSpawnApprovalToggle,
  onSaveConfig,
  onDeleteEdge,
  onSaveEdgeLabel
}: {
  node: NodeState;
  edges: EdgeState[];
  configDraft: NodeConfigDraft;
  configDirty: boolean;
  configSaving: boolean;
  configDisabled: boolean;
  configError: string | null;
  canSaveConfig: boolean;
  onConfigChange: (patch: Partial<NodeConfigDraft>) => void;
  roleTemplateOptions: string[];
  promptOverrideMode: 'template' | 'custom';
  customPromptValid: boolean;
  onPromptOverrideModeChange: (mode: 'template' | 'custom') => void;
  onCapabilityToggle: (key: keyof NodeCapabilities) => void;
  onPermissionsModeChange: (mode: NodePermissions['cliPermissionsMode']) => void;
  onSpawnApprovalToggle: () => void;
  onSaveConfig: () => void;
  onDeleteEdge: (edgeId: string) => void;
  onSaveEdgeLabel: (edgeId: string, label: string) => void;
}) {
  const formatTime = (iso: string) => {
    const date = new Date(iso);
    return date.toLocaleTimeString('en-US', { hour12: false });
  };

  return (
    <div className="inspector__section">
      {/* Configuration */}
      <div className="inspector__group inspector__group--config">
        <h3 className="inspector__group-title">Configuration</h3>
        <div className="inspector__form">
          <label className="inspector__field">
            <span className="inspector__field-label">Label</span>
            <input
              className="inspector__input"
              value={configDraft.label}
              onChange={(event) => onConfigChange({ label: event.target.value })}
              disabled={configDisabled}
            />
          </label>
          <label className="inspector__field">
            <span className="inspector__field-label">Role Template</span>
            <select
              className="inspector__select"
              value={configDraft.roleTemplate}
              onChange={(event) => onConfigChange({ roleTemplate: event.target.value })}
              disabled={configDisabled}
            >
              {roleTemplateOptions.map((option) => (
                <option key={option} value={option}>
                  {option.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="inspector__field">
            <span className="inspector__field-label">Prompt Override</span>
            <select
              className="inspector__select"
              value={promptOverrideMode}
              onChange={(event) => onPromptOverrideModeChange(event.target.value as 'template' | 'custom')}
              disabled={configDisabled}
            >
              <option value="template">TEMPLATE</option>
              <option value="custom">CUSTOM</option>
            </select>
          </label>
          {promptOverrideMode === 'custom' && (
            <label className="inspector__field inspector__field--full">
              <span className="inspector__field-label">Custom Prompt</span>
              <textarea
                className="inspector__textarea inspector__textarea--config"
                value={configDraft.customSystemPrompt}
                onChange={(event) => onConfigChange({ customSystemPrompt: event.target.value })}
                disabled={configDisabled}
                rows={6}
                placeholder="Paste or write a full role prompt override..."
              />
              {!customPromptValid && (
                <span className="inspector__field-hint inspector__field-hint--error">
                  Custom prompt is required when override is set to Custom.
                </span>
              )}
            </label>
          )}
        </div>
        <div className="inspector__config-grid">
          <div className="inspector__config-column">
            <span className="inspector__field-label">Permissions</span>
            <label className="inspector__toggle">
              <input
                type="checkbox"
                checked={configDraft.permissions.spawnRequiresApproval}
                onChange={onSpawnApprovalToggle}
                disabled={configDisabled}
              />
              <span>Spawn requires approval</span>
            </label>
            <label className="inspector__field">
              <span className="inspector__field-label">CLI Permissions</span>
              <select
                className="inspector__select"
                value={configDraft.permissions.cliPermissionsMode}
                onChange={(event) => onPermissionsModeChange(event.target.value as NodePermissions['cliPermissionsMode'])}
                disabled={configDisabled}
              >
                {PERMISSIONS_MODE_OPTIONS.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="inspector__config-column">
            <span className="inspector__field-label">Capabilities</span>
            {Object.entries(configDraft.capabilities).map(([key, value]) => (
              <label key={key} className="inspector__toggle">
                <input
                  type="checkbox"
                  checked={value}
                  onChange={() => onCapabilityToggle(key as keyof NodeCapabilities)}
                  disabled={configDisabled}
                />
                <span>{key.replace(/([A-Z])/g, ' $1').trim()}</span>
              </label>
            ))}
          </div>
        </div>
        {configError && <div className="inspector__config-error">{configError}</div>}
        <div className="inspector__config-actions">
          {configDirty && <span className="inspector__config-hint">Unsaved changes</span>}
          <button
            className="inspector__btn inspector__btn--secondary"
            type="button"
            onClick={onSaveConfig}
            disabled={!canSaveConfig}
            title="Save settings"
          >
            {configSaving ? 'Saving...' : <Check width={14} height={14} />}
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="inspector__group">
        <h3 className="inspector__group-title">Live Summary</h3>
        <p className="inspector__summary">{node.summary || 'No activity yet'}</p>
      </div>

      {/* Connection */}
      <div className="inspector__group">
        <h3 className="inspector__group-title">Connection</h3>
        <div className="inspector__kv-list">
          <div className="inspector__kv">
            <span className="inspector__kv-key">Status</span>
            <span className={`inspector__kv-value inspector__kv-value--${node.connection?.status ?? 'idle'}`}>
              {node.connection?.status ?? 'idle'}
            </span>
          </div>
          <div className="inspector__kv">
            <span className="inspector__kv-key">Streaming</span>
            <span className="inspector__kv-value">{node.connection?.streaming ? 'Yes' : 'No'}</span>
          </div>
          <div className="inspector__kv">
            <span className="inspector__kv-key">Session ID</span>
            <span className="inspector__kv-value inspector__kv-value--mono">
              {node.session.sessionId || 'none'}
            </span>
          </div>
          <div className="inspector__kv">
            <span className="inspector__kv-key">Last Activity</span>
            <span className="inspector__kv-value">{formatTime(node.lastActivityAt)}</span>
          </div>
          {node.inboxCount !== undefined && node.inboxCount > 0 && (
            <div className="inspector__kv">
              <span className="inspector__kv-key">Inbox</span>
              <span className="inspector__kv-value inspector__kv-value--accent">
                {node.inboxCount} pending
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Edges */}
      {edges.length > 0 && (
        <div className="inspector__group">
          <h3 className="inspector__group-title">Connections ({edges.length})</h3>
          <ul className="inspector__edge-list">
            {edges.map((edge) => (
              <li key={edge.id} className="inspector__edge">
                <span className="inspector__edge-direction">
                  {edge.from === node.id ? '\u2192' : '\u2190'}
                </span>
                <EditableEdgeLabel
                  edgeId={edge.id}
                  label={edge.label}
                  onSave={(newLabel) => onSaveEdgeLabel(edge.id, newLabel)}
                />
                <span className="inspector__edge-type">{edge.type}</span>
                <button
                  className="inspector__edge-delete"
                  type="button"
                  onClick={() => onDeleteEdge(edge.id)}
                  title="Delete edge"
                >
                  <Trash width={12} height={12} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Editable edge label component */
function EditableEdgeLabel({ edgeId, label, onSave }: { edgeId: string; label: string; onSave: (label: string) => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(label);

  const handleDoubleClick = () => {
    setIsEditing(true);
    setEditValue(label);
  };

  const handleBlur = () => {
    setIsEditing(false);
    if (editValue.trim() && editValue !== label) {
      onSave(editValue.trim());
      console.log('[edge-label] saved:', { edgeId, from: label, to: editValue.trim() });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleBlur();
    }
    if (e.key === 'Escape') {
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
        onChange={(e) => setEditValue(e.target.value)}
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
      {label}
    </span>
  );
}

function HandoffsTab({ handoffs, nodeId }: { handoffs: Envelope[]; nodeId: string }) {
  if (handoffs.length === 0) {
    return (
      <div className="inspector__empty">
        <span className="inspector__empty-text">No handoffs yet</span>
      </div>
    );
  }

  return (
    <div className="inspector__section">
      {handoffs.map((handoff) => (
        <div
          key={handoff.id}
          className={`inspector__handoff ${handoff.fromNodeId === nodeId ? 'inspector__handoff--outgoing' : 'inspector__handoff--incoming'}`}
        >
          <div className="inspector__handoff-header">
            <span className="inspector__handoff-direction">
              {handoff.fromNodeId === nodeId ? 'Outgoing' : 'Incoming'}
            </span>
            <span className="inspector__handoff-time">
              {new Date(handoff.createdAt).toLocaleTimeString('en-US', { hour12: false })}
            </span>
          </div>
          <p className="inspector__handoff-message">{handoff.payload.message}</p>
          {handoff.payload.status && (
            <div className={`inspector__handoff-status ${handoff.payload.status.ok ? 'inspector__handoff-status--ok' : 'inspector__handoff-status--fail'}`}>
              {handoff.payload.status.ok ? '\u2713' : '\u2717'} {handoff.payload.status.reason || 'No reason'}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DiffsTab({ diffs }: { diffs: Artifact[] }) {
  if (diffs.length === 0) {
    return (
      <div className="inspector__empty">
        <span className="inspector__empty-text">No diffs produced</span>
      </div>
    );
  }

  return (
    <div className="inspector__section">
      {diffs.map((diff) => (
        <div key={diff.id} className="inspector__artifact">
          <div className="inspector__artifact-header">
            <span className="inspector__artifact-name">{diff.name}</span>
            <span className="inspector__artifact-time">
              {new Date(diff.createdAt).toLocaleTimeString('en-US', { hour12: false })}
            </span>
          </div>
          {diff.metadata?.filesChanged && (
            <div className="inspector__artifact-files">
              {diff.metadata.filesChanged.map((file) => (
                <span key={file} className="inspector__artifact-file">{file}</span>
              ))}
            </div>
          )}
          {diff.metadata?.summary && (
            <p className="inspector__artifact-summary">{diff.metadata.summary}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function TextArtifactsTab({
  artifacts,
  emptyLabel,
  contentById,
  loadingId,
  onLoad,
  error
}: {
  artifacts: Artifact[];
  emptyLabel: string;
  contentById: Record<string, string>;
  loadingId: string | null;
  onLoad: (artifactId: string) => void;
  error: string | null;
}) {
  if (artifacts.length === 0) {
    return (
      <div className="inspector__empty">
        <span className="inspector__empty-text">{emptyLabel}</span>
      </div>
    );
  }

  return (
    <div className="inspector__section">
      {error && <div className="inspector__error">{error}</div>}
      {artifacts.map((artifact) => {
        const content = contentById[artifact.id];
        const isLoading = loadingId === artifact.id;
        return (
          <div key={artifact.id} className="inspector__artifact">
            <div className="inspector__artifact-header">
              <span className={`inspector__artifact-kind inspector__artifact-kind--${artifact.kind}`}>
                {artifact.kind}
              </span>
              <span className="inspector__artifact-name">{artifact.name}</span>
              <span className="inspector__artifact-time">
                {new Date(artifact.createdAt).toLocaleTimeString('en-US', { hour12: false })}
              </span>
            </div>
            {content ? (
              <pre className="inspector__artifact-preview">{content}</pre>
            ) : (
              <div className="inspector__artifact-actions">
                <button
                  className="inspector__btn inspector__btn--secondary"
                  onClick={() => onLoad(artifact.id)}
                  disabled={isLoading}
                  title="View"
                >
                  {isLoading ? 'Loading' : <Eye width={14} height={14} />}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ArtifactsTab({ artifacts }: { artifacts: Artifact[] }) {
  if (artifacts.length === 0) {
    return (
      <div className="inspector__empty">
        <span className="inspector__empty-text">No artifacts</span>
      </div>
    );
  }

  return (
    <div className="inspector__section">
      {artifacts.map((artifact) => (
        <div key={artifact.id} className="inspector__artifact">
          <div className="inspector__artifact-header">
            <span className={`inspector__artifact-kind inspector__artifact-kind--${artifact.kind}`}>
              {artifact.kind}
            </span>
            <span className="inspector__artifact-name">{artifact.name}</span>
          </div>
          <span className="inspector__artifact-path">{artifact.path}</span>
        </div>
      ))}
    </div>
  );
}

function ToolsTab({ toolEvents }: { toolEvents: ToolEvent[] }) {
  if (toolEvents.length === 0) {
    return (
      <div className="inspector__empty">
        <span className="inspector__empty-text">No tool events yet</span>
      </div>
    );
  }

  const getStatusColor = (status: ToolEvent['status']) => {
    switch (status) {
      case 'proposed': return 'inspector__tool-status--proposed';
      case 'started': return 'inspector__tool-status--started';
      case 'completed': return 'inspector__tool-status--completed';
      case 'failed': return 'inspector__tool-status--failed';
      default: return '';
    }
  };

  return (
    <div className="inspector__section">
      {toolEvents.map((event) => (
        <div key={event.id} className="inspector__tool">
          <div className="inspector__tool-header">
            <span className="inspector__tool-name">{event.tool.name}</span>
            <span className={`inspector__tool-status ${getStatusColor(event.status)}`}>
              {event.status}
            </span>
          </div>
          <div className="inspector__tool-time">
            {new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false })}
          </div>
          {Object.keys(event.tool.args).length > 0 && (
            <div className="inspector__tool-args">
              <pre className="inspector__tool-args-code">
                {JSON.stringify(event.tool.args, null, 2)}
              </pre>
            </div>
          )}
          {event.error && (
            <div className="inspector__tool-error">
              {event.error.message}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
