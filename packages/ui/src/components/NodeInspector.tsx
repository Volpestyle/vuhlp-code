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
 * - Controls: start/stop process, pause running turn, interrupt/queue message, reset context
 */

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type RefObject, type MutableRefObject } from 'react';
import type {
  NodeState,
  Artifact,
  EdgeState,
  ProviderName,
  NodeCapabilities,
  NodePermissions,
  GetRoleTemplateResponse,
  UsageTotals,
  TodoItem
} from '@vuhlp/contracts';
import {
  buildTimeline,
  formatClockTime,
  EDGE_MANAGEMENT_OPTIONS,
  parsePermissionsMode,
  parseEdgeManagement,
  parseProviderName,
  PERMISSIONS_MODE_OPTIONS,
  PROVIDER_OPTIONS,
  isHandoffTimelineItem,
  buildReceiveHandoffToolEvent,
} from '@vuhlp/shared';
import { useRunStore, type NodeLogEntry, type TimelineEvent } from '../stores/runStore';
import type { ChatMessage } from '@vuhlp/contracts';
import { useChatAutoScroll } from '../hooks/useChatAutoScroll';
import { useEventHistoryPaging } from '../hooks/useEventHistoryPaging';
import { TimelineItem } from './TimelineItem';
import {
  createEdge,
  deleteEdge,
  deleteNode,
  getArtifactContent,
  getRoleTemplate,
  interruptNodeProcess,
  postChat,
  resetNode,
  startNodeProcess,
  stopNodeProcess,
  updateNode
} from '../lib/api';
import { StatusBadge } from './StatusBadge';
import { ProviderBadge } from './ProviderBadge';
import { ThinkingSpinner } from '@vuhlp/spinners';
import { RefreshDouble, Trash, Check, Eye, NavArrowDown, NavArrowRight } from 'iconoir-react';
import { motion, AnimatePresence } from 'framer-motion';
import './NodeInspector.css';

interface NodeInspectorProps {
  node: NodeState;
}

type InspectorTab = 'overview' | 'chat' | 'prompts' | 'transcripts' | 'diffs' | 'artifacts' | 'tools';
type ChatFilter = 'all' | 'handoffs';
const ROLE_TEMPLATE_OPTIONS = ['orchestrator', 'planner', 'implementer', 'reviewer', 'investigator'];
const TEMPLATE_PREVIEW_HEIGHT_STORAGE_KEY = 'vuhlp-template-preview-height';
const DEFAULT_TEMPLATE_PREVIEW_HEIGHT = 160;
const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];
type BooleanCapability = Exclude<keyof NodeCapabilities, 'edgeManagement'>;
const BOOLEAN_CAPABILITIES: BooleanCapability[] = [
  'writeCode',
  'writeDocs',
  'runCommands',
  'delegateOnly',
];




type NodeConfigDraft = {
  label: string;
  roleTemplate: string;
  customSystemPrompt: string;
  capabilities: NodeCapabilities;
  permissions: NodePermissions;
};

const areCapabilitiesEqual = (a: NodeCapabilities, b: NodeCapabilities) =>
  a.edgeManagement === b.edgeManagement &&
  a.writeCode === b.writeCode &&
  a.writeDocs === b.writeDocs &&
  a.runCommands === b.runCommands &&
  a.delegateOnly === b.delegateOnly;

const arePermissionsEqual = (a: NodePermissions, b: NodePermissions) =>
  a.cliPermissionsMode === b.cliPermissionsMode &&
  a.agentManagementRequiresApproval === b.agentManagementRequiresApproval;

export function NodeInspector({ node }: NodeInspectorProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>('overview');
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all');
  const [messageInput, setMessageInput] = useState('');
  const [messageError, setMessageError] = useState<string | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);
  const [processPending, setProcessPending] = useState<'start' | 'stop' | 'interrupt' | null>(null);
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
  const [templatePreview, setTemplatePreview] = useState<GetRoleTemplateResponse | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templatePreviewHeight, setTemplatePreviewHeight] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_TEMPLATE_PREVIEW_HEIGHT;
    const stored = window.localStorage.getItem(TEMPLATE_PREVIEW_HEIGHT_STORAGE_KEY);
    const parsed = stored ? Number(stored) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : DEFAULT_TEMPLATE_PREVIEW_HEIGHT;
  });
  const [artifactContent, setArtifactContent] = useState<Record<string, string>>({});
  const [loadingArtifactId, setLoadingArtifactId] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const templatePreviewRef = useRef<HTMLPreElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottomRef = useRef<(() => void) | null>(null);
  const getNodeArtifacts = useRunStore((s) => s.getNodeArtifacts);
  const getNodeEdges = useRunStore((s) => s.getNodeEdges);

  const recentHandoffs = useRunStore((s) => s.recentHandoffs);
  const run = useRunStore((s) => s.run);
  const runId = useRunStore((s) => s.run?.id);
  const runUsage = useRunStore((s) => s.run?.usage);
  const removeNode = useRunStore((s) => s.removeNode);
  const removeEdge = useRunStore((s) => s.removeEdge);
  const addEdge = useRunStore((s) => s.addEdge);
  const addChatMessage = useRunStore((s) => s.addChatMessage);
  const clearNodeMessages = useRunStore((s) => s.clearNodeMessages);
  const messages = useRunStore((s) => s.chatMessages[node.id]);
  const toolEvents = useRunStore((s) => s.toolEvents);
  const turnStatusEvents = useRunStore((s) => s.turnStatusEvents);
  const nodeLogs = useRunStore((s) => s.nodeLogs);
  const nodeToolEvents = useMemo(
    () => toolEvents.filter((event) => event.nodeId === node.id),
    [toolEvents, node.id]
  );
  const nodeStatusEvents = useMemo(
    () => turnStatusEvents.filter((event) => event.nodeId === node.id),
    [turnStatusEvents, node.id]
  );
  const nodeLogTail = useMemo<NodeLogEntry[]>(
    () => nodeLogs[node.id] ?? [],
    [nodeLogs, node.id]
  );
  const safeMessages = messages ?? EMPTY_CHAT_MESSAGES;
  const incomingHandoffs = useMemo(
    () => recentHandoffs.filter((handoff) => handoff.toNodeId === node.id),
    [recentHandoffs, node.id]
  );
  const incomingHandoffTools = useMemo(
    () => incomingHandoffs.map((handoff) => buildReceiveHandoffToolEvent(handoff)),
    [incomingHandoffs]
  );
  const combinedToolEvents = useMemo(
    () => [...nodeToolEvents, ...incomingHandoffTools],
    [nodeToolEvents, incomingHandoffTools]
  );
  const timeline = useMemo(
    () => buildTimeline(safeMessages, combinedToolEvents, nodeStatusEvents),
    [safeMessages, combinedToolEvents, nodeStatusEvents]
  );
  const isStreaming = useMemo(() => {
    const lastMessage = [...timeline].reverse().find((item) => item.type === 'message');
    return Boolean(
      lastMessage?.type === 'message' && (lastMessage.data.streaming || lastMessage.data.thinkingStreaming)
    );
  }, [timeline]);
  const handoffCount = useMemo(() => timeline.filter(isHandoffTimelineItem).length, [timeline]);
  const filteredTimeline = useMemo(
    () => (chatFilter === 'handoffs' ? timeline.filter(isHandoffTimelineItem) : timeline),
    [chatFilter, timeline]
  );

  const artifacts = getNodeArtifacts(node.id);
  const edges = getNodeEdges(node.id);

  const diffs = artifacts.filter((a) => a.kind === 'diff');
  const prompts = artifacts
    .filter((a) => a.kind === 'prompt')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const transcripts = artifacts
    .filter((a) => a.kind === 'transcript')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const isOrchestrator = node.roleTemplate.trim().toLowerCase() === 'orchestrator';
  const isAutoMode = run?.mode === 'AUTO';

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
    setProcessError(null);
    setProcessPending(null);
  }, [
    node.id,
    node.label,
    node.roleTemplate,
    node.customSystemPrompt,
    node.capabilities,
    node.permissions,
  ]);

  useEffect(() => {
    if (promptOverrideMode !== 'template') {
      setTemplatePreview(null);
      setTemplateLoading(false);
      setTemplateError(null);
      return;
    }
    const name = configDraft.roleTemplate.trim();
    if (!name) {
      setTemplatePreview(null);
      setTemplateLoading(false);
      setTemplateError(null);
      return;
    }
    let cancelled = false;
    setTemplateLoading(true);
    setTemplateError(null);
    void getRoleTemplate(name)
      .then((template) => {
        if (cancelled) return;
        setTemplatePreview(template);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setTemplateError(message);
        setTemplatePreview(null);
      })
      .finally(() => {
        if (!cancelled) {
          setTemplateLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [configDraft.roleTemplate, promptOverrideMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        TEMPLATE_PREVIEW_HEIGHT_STORAGE_KEY,
        String(Math.round(templatePreviewHeight))
      );
    } catch {
      // Ignore storage errors (private mode or blocked storage).
    }
  }, [templatePreviewHeight]);

  useEffect(() => {
    if (promptOverrideMode !== 'template') return;
    const element = templatePreviewRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const nextHeight = Math.round(entry.contentRect.height);
        setTemplatePreviewHeight((prev) => (prev === nextHeight ? prev : nextHeight));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [promptOverrideMode]);

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
  const connectionStatus = node.connection?.status ?? 'disconnected';
  const canStartProcess = Boolean(runId) && connectionStatus === 'disconnected' && !processPending;
  const canStopProcess = Boolean(runId) && connectionStatus !== 'disconnected' && !processPending;
  const canInterruptProcess = Boolean(runId) && node.status === 'running' && !processPending;

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
    const normalized = content.toLowerCase();
    if (normalized === '/new' || normalized === '/clear') {
      setMessageInput('');
      setMessageError(null);
      handleResetContext();
      return;
    }
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
    scrollToBottomRef.current?.();
  };

  const handleProviderChange = (value: string) => {
    const nextProvider = parseProviderName(value);
    if (!nextProvider) {
      console.warn('[inspector] unknown provider option', value);
      return;
    }
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

  const handleBooleanCapabilityToggle = (key: BooleanCapability) => {
    setConfigDraft((prev) => ({
      ...prev,
      capabilities: { ...prev.capabilities, [key]: !prev.capabilities[key] },
    }));
  };

  const handleEdgeManagementChange = (value: string) => {
    const nextValue = parseEdgeManagement(value);
    if (!nextValue) {
      console.warn('[inspector] unknown edge management', value);
      setConfigError('Unsupported edge management selected.');
      return;
    }
    setConfigError(null);
    setConfigDraft((prev) => ({
      ...prev,
      capabilities: { ...prev.capabilities, edgeManagement: nextValue },
    }));
  };

  const handlePermissionsModeChange = (value: string) => {
    const mode = parsePermissionsMode(value);
    if (!mode) {
      console.warn('[inspector] unknown permissions mode', value);
      setConfigError('Unsupported permissions mode selected.');
      return;
    }
    setConfigError(null);
    setConfigDraft((prev) => ({
      ...prev,
      permissions: { ...prev.permissions, cliPermissionsMode: mode },
    }));
  };

  const handleAgentManagementApprovalToggle = () => {
    setConfigDraft((prev) => ({
      ...prev,
      permissions: {
        ...prev.permissions,
        agentManagementRequiresApproval: !prev.permissions.agentManagementRequiresApproval,
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
    clearNodeMessages(node.id);
    setMessageInput('');
    setMessageError(null);
    if (!runId) {
      console.warn('[inspector] cannot reset context without active run');
      return;
    }
    void resetNode(runId, node.id).catch((error) => {
      console.error('[inspector] failed to reset context', error);
    });
  };

  const handleStartProcess = () => {
    if (!runId) {
      setProcessError('Start a run to manage the process.');
      console.warn('[inspector] cannot start process without active run');
      return;
    }
    setProcessPending('start');
    setProcessError(null);
    void startNodeProcess(runId, node.id)
      .catch((error) => {
        console.error('[inspector] failed to start process', error);
        setProcessError('Failed to start process.');
      })
      .finally(() => setProcessPending(null));
  };

  const handleStopProcess = () => {
    if (!runId) {
      setProcessError('Start a run to manage the process.');
      console.warn('[inspector] cannot stop process without active run');
      return;
    }
    setProcessPending('stop');
    setProcessError(null);
    void stopNodeProcess(runId, node.id)
      .catch((error) => {
        console.error('[inspector] failed to stop process', error);
        setProcessError('Failed to stop process.');
      })
      .finally(() => setProcessPending(null));
  };

  const handleInterruptProcess = () => {
    if (!runId) {
      setProcessError('Start a run to manage the process.');
      console.warn('[inspector] cannot interrupt process without active run');
      return;
    }
    setProcessPending('interrupt');
    setProcessError(null);
    void interruptNodeProcess(runId, node.id)
      .catch((error) => {
        console.error('[inspector] failed to interrupt process', error);
        setProcessError('Failed to pause process.');
      })
      .finally(() => setProcessPending(null));
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

  const todos = node.todos ?? [];

  const [todosExpanded, setTodosExpanded] = useState(true);

  const tabs: { id: InspectorTab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'chat', label: 'Chat' },
    { id: 'prompts', label: 'Prompts', count: prompts.length },
    { id: 'transcripts', label: 'Transcripts', count: transcripts.length },
    { id: 'diffs', label: 'Diffs', count: diffs.length },
    { id: 'artifacts', label: 'Artifacts', count: artifacts.length },
  ];

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      handleSendMessage(false);
    }
  };

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
                onChange={(event) => handleProviderChange(event.target.value)}
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
            <div className="inspector__role-row">
              <span className="inspector__role">
                {node.customSystemPrompt ? 'custom' : node.roleTemplate}
              </span>
              {isOrchestrator && (
                <span className="inspector__role-badge inspector__role-badge--orchestrator">
                  Orchestrator
                </span>
              )}
              {isOrchestrator && isAutoMode && (
                <span className="inspector__role-badge inspector__role-badge--auto">Auto Loop</span>
              )}
            </div>
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
      <div className="inspector__content" ref={contentRef}>
        {activeTab === 'overview' && (
          <OverviewTab
            node={node}
            edges={edges}
            nodeLogs={nodeLogTail}
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
            templatePreview={templatePreview}
            templateLoading={templateLoading}
            templateError={templateError}
            templatePreviewRef={templatePreviewRef}
            templatePreviewHeight={templatePreviewHeight}
            onPromptOverrideModeChange={setPromptOverrideMode}
            onBooleanCapabilityToggle={handleBooleanCapabilityToggle}
            onEdgeManagementChange={handleEdgeManagementChange}
            onPermissionsModeChange={handlePermissionsModeChange}
            onAgentManagementApprovalToggle={handleAgentManagementApprovalToggle}
            onSaveConfig={handleSaveConfig}
            onDeleteEdge={handleDeleteEdge}
            onSaveEdgeLabel={handleSaveEdgeLabel}
            runUsage={runUsage}
            onStartProcess={handleStartProcess}
            onStopProcess={handleStopProcess}
            onInterruptProcess={handleInterruptProcess}
            canStartProcess={canStartProcess}
            canStopProcess={canStopProcess}
            canInterruptProcess={canInterruptProcess}
            processPending={processPending}
            processError={processError}
          />
        )}
        {activeTab === 'chat' && (
          <ChatTab
            timeline={filteredTimeline}
            nodeLabel={node.label}
            nodeStatus={node.status}
            nodeId={node.id}
            scrollRef={contentRef}
            scrollToBottomRef={scrollToBottomRef}
            filter={chatFilter}
            allCount={timeline.length}
            handoffCount={handoffCount}
            isStreaming={isStreaming}
            onFilterChange={setChatFilter}
            todos={todos}
            todosExpanded={todosExpanded}
            onTodosToggle={() => setTodosExpanded(!todosExpanded)}
          />
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
      </div>

      {/* Controls */}
      <footer className="inspector__footer">
        <div className="inspector__message-input">
          <textarea
            className="inspector__textarea"
            placeholder="Send message to node..."
            value={messageInput}
            onChange={handleMessageChange}
            onKeyDown={handleKeyDown}
            rows={2}
          />
          {messageError && <div className="inspector__error">{messageError}</div>}
          <div className="inspector__message-actions">
            {node.status === 'running' ? (
              <>
                <button
                  className="btn btn--secondary"
                  onClick={() => handleSendMessage(false)}
                  disabled={!messageInput.trim()}
                  title="Queue message for next turn"
                >
                  Queue
                </button>
                <button
                  className="btn btn--primary"
                  onClick={() => handleSendMessage(true)}
                  disabled={!messageInput.trim()}
                  title="Interrupt and send immediately"
                >
                  Interrupt
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn btn--secondary"
                  disabled
                  title="Queue is only available when running"
                >
                  Queue
                </button>
                <button
                  className="btn btn--primary"
                  onClick={() => handleSendMessage(false)}
                  disabled={!messageInput.trim()}
                  title="Send message"
                >
                  Send
                </button>
              </>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

function ChatTab({
  timeline,
  nodeLabel,
  nodeStatus,
  nodeId,
  scrollRef,
  scrollToBottomRef,
  filter,
  allCount,
  handoffCount,
  isStreaming,
  onFilterChange,
  todos,
  todosExpanded,
  onTodosToggle,
}: {
  timeline: TimelineEvent[];
  nodeLabel: string;
  nodeStatus?: string;
  nodeId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollToBottomRef: MutableRefObject<(() => void) | null>;
  filter: ChatFilter;
  allCount: number;
  handoffCount: number;
  isStreaming: boolean;
  onFilterChange: (filter: ChatFilter) => void;
  todos: TodoItem[];
  todosExpanded: boolean;
  onTodosToggle: () => void;
}) {
  const autoScrollKey = useMemo(
    () => `${nodeStatus ?? ''}-${isStreaming ? '1' : '0'}-${filter}`,
    [nodeStatus, isStreaming, filter]
  );
  const { scrollToBottom } = useChatAutoScroll({ scrollRef, timeline, updateKey: autoScrollKey, resetKey: nodeId });
  const { hasMore, loadingOlder, error: historyError, loadOlder } = useEventHistoryPaging();
  const autoLoadRef = useRef(0);

  // Expose scrollToBottom to parent via ref
  useEffect(() => {
    scrollToBottomRef.current = scrollToBottom;
    return () => {
      scrollToBottomRef.current = null;
    };
  }, [scrollToBottom, scrollToBottomRef]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (!hasMore || loadingOlder) return;
      if (container.scrollTop > 120) return;
      const now = Date.now();
      if (now - autoLoadRef.current < 750) return;
      autoLoadRef.current = now;
      void loadOlder();
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [scrollRef, hasMore, loadingOlder, loadOlder]);

  if (allCount === 0 && !hasMore && nodeStatus !== 'running' && import.meta.env.VITE_TEST_CUBE_SPINNER !== 'true') {
     return (
      <div className="inspector__empty">
        <span className="inspector__empty-text">Start a conversation with {nodeLabel}</span>
      </div>
    );
  }

  const showEmpty =
    timeline.length === 0 &&
    !hasMore &&
    nodeStatus !== 'running' &&
    import.meta.env.VITE_TEST_CUBE_SPINNER !== 'true';

  return (
    <div className="inspector__section inspector__chat">
      <div className="inspector__chat-controls">
        <div className="inspector__chat-filter">
          <button
            className={`inspector__chat-filter-button ${filter === 'all' ? 'inspector__chat-filter-button--active' : ''}`}
            type="button"
            onClick={() => onFilterChange('all')}
          >
            All
            <span className="inspector__chat-filter-count">{allCount}</span>
          </button>
          <button
            className={`inspector__chat-filter-button ${filter === 'handoffs' ? 'inspector__chat-filter-button--active' : ''}`}
            type="button"
            onClick={() => onFilterChange('handoffs')}
          >
            Handoffs
            <span className="inspector__chat-filter-count">{handoffCount}</span>
          </button>
        </div>
      </div>
      
      {showEmpty ? (
        <div className="inspector__empty">
            <span className="inspector__empty-text">{filter === 'handoffs' ? 'No handoffs yet' : `Start a conversation with ${nodeLabel}`}</span>
        </div>
      ) : (
        <>
          {hasMore && (
            <div className="inspector__load-older">
              <button
                className="inspector__load-older-button"
                type="button"
                onClick={() => {
                  void loadOlder();
                }}
                disabled={loadingOlder}
              >
                {loadingOlder ? 'Loading earlier…' : 'Load earlier'}
              </button>
            </div>
          )}
          {historyError && (
            <div className="inspector__load-older-error" role="alert">
              Failed to load older events: {historyError}
            </div>
          )}
          {timeline.map((item) => (
            <TimelineItem key={`${item.type}-${item.data.id}`} item={item} />
          ))}
          {(nodeStatus === 'running' && !isStreaming) || import.meta.env.VITE_TEST_CUBE_SPINNER === 'true' ? (
            <div className="timeline-message timeline-message--assistant timeline-message--thinking">
              <div className="timeline-message__header">
                <span className="timeline-message__role">assistant</span>
                <div className="timeline-message__meta">
                  <span className="timeline-message__streaming timeline-message__streaming--thinking">
                    <ThinkingSpinner size="sm" variant="assemble" color="#7aedc4" />
                    thinking
                  </span>
                </div>
              </div>
              <div className="timeline-message__content">
                <ThinkingSpinner size="lg" variant="assemble" color="#7aedc4" />
              </div>
            </div>
          ) : null}
        </>
      )}

      {/* Collapsible Todos Section */}
      {todos.length > 0 && (
        <div className="inspector__todos-panel">
          <button
            className="inspector__todos-toggle"
            onClick={onTodosToggle}
            type="button"
          >
            <motion.span
              className="inspector__todos-toggle-icon"
              animate={{ rotate: todosExpanded ? 90 : 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 50 }}
            >
              ▶
            </motion.span>
            <span className="inspector__todos-toggle-label">
              Todos
              <span className="inspector__todos-toggle-count">({todos.length})</span>
            </span>
            <span className="inspector__todos-toggle-summary">
              {todos.filter(t => t.status === 'in_progress').length > 0 && (
                <span className="inspector__todos-badge inspector__todos-badge--in-progress">
                  {todos.filter(t => t.status === 'in_progress').length} active
                </span>
              )}
              {todos.filter(t => t.status === 'completed').length > 0 && (
                <span className="inspector__todos-badge inspector__todos-badge--completed">
                  {todos.filter(t => t.status === 'completed').length} done
                </span>
              )}
            </span>
          </button>
          <AnimatePresence initial={false}>
            {todosExpanded && (
              <motion.div
                initial={{ height: 0 }}
                animate={{ height: 'auto' }}
                exit={{ height: 0 }}
                transition={{ type: 'spring', stiffness: 500, damping: 50 }}
                style={{ overflow: 'hidden' }}
              >
                <motion.ul
                  className="inspector__todos-list"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.1 }}
                >
                  {todos.map((todo, index) => (
                    <motion.li
                      key={`${todo.content}-${index}`}
                      className={`inspector__todo inspector__todo--${todo.status.replace('_', '-')}`}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.02, type: 'spring', stiffness: 500, damping: 50 }}
                    >
                      <span className={`inspector__todo-status inspector__todo-status--${todo.status.replace('_', '-')}`}>
                        {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '▶' : '○'}
                      </span>
                      <span className="inspector__todo-content">
                        {todo.status === 'in_progress' ? todo.activeForm : todo.content}
                      </span>
                    </motion.li>
                  ))}
                </motion.ul>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function OverviewTab({
  node,
  edges,
  nodeLogs,
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
  templatePreview,
  templateLoading,
  templateError,
  templatePreviewRef,
  templatePreviewHeight,
  onPromptOverrideModeChange,
  onBooleanCapabilityToggle,
  onEdgeManagementChange,
  onPermissionsModeChange,
  onAgentManagementApprovalToggle,
  onSaveConfig,
  onDeleteEdge,
  onSaveEdgeLabel,
  runUsage,
  onStartProcess,
  onStopProcess,
  onInterruptProcess,
  canStartProcess,
  canStopProcess,
  canInterruptProcess,
  processPending,
  processError
}: {
  node: NodeState;
  edges: EdgeState[];
  nodeLogs: NodeLogEntry[];
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
  templatePreview: GetRoleTemplateResponse | null;
  templateLoading: boolean;
  templateError: string | null;
  templatePreviewRef: RefObject<HTMLPreElement | null>;
  templatePreviewHeight: number;
  onPromptOverrideModeChange: (mode: 'template' | 'custom') => void;
  onBooleanCapabilityToggle: (key: BooleanCapability) => void;
  onEdgeManagementChange: (value: string) => void;
  onPermissionsModeChange: (mode: string) => void;
  onAgentManagementApprovalToggle: () => void;
  onSaveConfig: () => void;
  onDeleteEdge: (edgeId: string) => void;
  onSaveEdgeLabel: (edgeId: string, label: string) => void;
  runUsage?: UsageTotals;
  onStartProcess: () => void;
  onStopProcess: () => void;
  onInterruptProcess: () => void;
  canStartProcess: boolean;
  canStopProcess: boolean;
  canInterruptProcess: boolean;
  processPending: 'start' | 'stop' | 'interrupt' | null;
  processError: string | null;
}) {
  const formatTokens = (value?: number) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return '—';
    }
    return value.toLocaleString('en-US');
  };
  const nodeUsage = node.usage;
  const hasUsage = Boolean(nodeUsage || runUsage);

  const [isTemplatePreviewExpanded, setIsTemplatePreviewExpanded] = useState(false);

  return (
    <div className="inspector__section">
      {/* Identity */}
      <div className="inspector__group">
        <h3 className="inspector__group-title">Identity</h3>
        <div className="inspector__kv-list">
          <div className="inspector__kv">
            <span className="inspector__kv-key">Node ID</span>
            <span className="inspector__kv-value inspector__kv-value--mono">{node.id}</span>
          </div>
          <div className="inspector__kv">
            <span className="inspector__kv-key">Alias</span>
            <span className="inspector__kv-value">{node.alias ?? "none"}</span>
          </div>
        </div>
      </div>

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
          {promptOverrideMode === 'template' && (
            <div className="inspector__field inspector__field--full">
              <div 
                className="inspector__section-header" 
                onClick={() => setIsTemplatePreviewExpanded(!isTemplatePreviewExpanded)}
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
              >
                {isTemplatePreviewExpanded ? (
                  <NavArrowDown width={14} height={14} />
                ) : (
                  <NavArrowRight width={14} height={14} />
                )}
                <span className="inspector__field-label" style={{ marginBottom: 0 }}>Template Preview</span>
              </div>
              
              {isTemplatePreviewExpanded && (
                <>
                  {templateError && (
                    <span className="inspector__field-hint inspector__field-hint--error">
                      {templateError}
                    </span>
                  )}
                  <pre
                    className="inspector__template-preview"
                    ref={templatePreviewRef}
                    style={{ height: `${templatePreviewHeight}px` }}
                  >
                    {templateLoading
                      ? <span className="inspector__loading"><ThinkingSpinner size="sm" color="#d4cef0" /> Loading template</span>
                      : templatePreview?.content ?? 'Select a role template to preview.'}
                  </pre>
                  {!templateLoading && templatePreview && !templatePreview.found && (
                    <span className="inspector__field-hint inspector__field-hint--error">
                      Template file not found in docs/templates.
                    </span>
                  )}
                </>
              )}
            </div>
          )}
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
                checked={configDraft.permissions.agentManagementRequiresApproval}
                onChange={onAgentManagementApprovalToggle}
                disabled={configDisabled}
              />
              <span>Agent management requires approval</span>
            </label>
            <label className="inspector__field">
              <span className="inspector__field-label">CLI Permissions</span>
              <select
                className="inspector__select"
                value={configDraft.permissions.cliPermissionsMode}
                onChange={(event) => onPermissionsModeChange(event.target.value)}
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
            <label className="inspector__field">
              <span className="inspector__field-label">Edge Management</span>
              <select
                className="inspector__select"
                value={configDraft.capabilities.edgeManagement}
                onChange={(event) => onEdgeManagementChange(event.target.value)}
                disabled={configDisabled}
              >
                {EDGE_MANAGEMENT_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            {BOOLEAN_CAPABILITIES.map((key) => (
              <label key={key} className="inspector__toggle">
                <input
                  type="checkbox"
                  checked={configDraft.capabilities[key]}
                  onChange={() => onBooleanCapabilityToggle(key)}
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
          {node.connection?.lastHeartbeatAt && (
            <div className="inspector__kv">
              <span className="inspector__kv-key">Last Heartbeat</span>
              <span className="inspector__kv-value">{formatClockTime(node.connection.lastHeartbeatAt)}</span>
            </div>
          )}
          {node.connection?.lastOutputAt && (
            <div className="inspector__kv">
              <span className="inspector__kv-key">Last Output</span>
              <span className="inspector__kv-value">{formatClockTime(node.connection.lastOutputAt)}</span>
            </div>
          )}
          <div className="inspector__kv">
            <span className="inspector__kv-key">Session ID</span>
            <span className="inspector__kv-value inspector__kv-value--mono">
              {node.session.sessionId || 'none'}
            </span>
          </div>
          <div className="inspector__kv">
            <span className="inspector__kv-key">Last Activity</span>
            <span className="inspector__kv-value">{formatClockTime(node.lastActivityAt)}</span>
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
        <div className="inspector__process-controls">
          <button
            className="inspector__btn inspector__btn--primary"
            type="button"
            onClick={onStartProcess}
            disabled={!canStartProcess}
            title="Start node process"
          >
            {processPending === 'start' ? 'Starting...' : 'Start'}
          </button>
          <button
            className="inspector__btn inspector__btn--secondary"
            type="button"
            onClick={onInterruptProcess}
            disabled={!canInterruptProcess}
            title="Pause running turn"
          >
            {processPending === 'interrupt' ? 'Pausing...' : 'Pause'}
          </button>
          <button
            className="inspector__btn inspector__btn--danger"
            type="button"
            onClick={onStopProcess}
            disabled={!canStopProcess}
            title="Stop node process"
          >
            {processPending === 'stop' ? 'Stopping...' : 'Stop'}
          </button>
        </div>
        {processError && (
          <span className="inspector__field-hint inspector__field-hint--error">
            {processError}
          </span>
        )}
      </div>

      {nodeLogs.length > 0 && (
        <div className="inspector__group">
          <h3 className="inspector__group-title">CLI Output (tail)</h3>
          <div className="inspector__log">
            {nodeLogs.map((entry) => (
              <div key={entry.id} className="inspector__log-line">
                <span className={`inspector__log-source inspector__log-source--${entry.source}`}>
                  {entry.source}
                </span>
                <span className="inspector__log-time">{formatClockTime(entry.timestamp)}</span>
                <span className="inspector__log-text">{entry.line}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Usage */}
      <div className="inspector__group">
        <h3 className="inspector__group-title">Usage</h3>
        {hasUsage ? (
          <div className="inspector__kv-list">
            {nodeUsage && (
              <>
                <div className="inspector__kv">
                  <span className="inspector__kv-key">Node Prompt</span>
                  <span className="inspector__kv-value">{formatTokens(nodeUsage.promptTokens)}</span>
                </div>
                <div className="inspector__kv">
                  <span className="inspector__kv-key">Node Completion</span>
                  <span className="inspector__kv-value">{formatTokens(nodeUsage.completionTokens)}</span>
                </div>
                <div className="inspector__kv">
                  <span className="inspector__kv-key">Node Total</span>
                  <span className="inspector__kv-value">{formatTokens(nodeUsage.totalTokens)}</span>
                </div>
              </>
            )}
            {runUsage && (
              <div className="inspector__kv">
                <span className="inspector__kv-key">Run Total</span>
                <span className="inspector__kv-value">{formatTokens(runUsage.totalTokens)}</span>
              </div>
            )}
          </div>
        ) : (
          <p className="inspector__summary">No usage telemetry yet.</p>
        )}
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
                  {isLoading ? <ThinkingSpinner size="sm" color="#d4cef0" /> : <Eye width={14} height={14} />}
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
