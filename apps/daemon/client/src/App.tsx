import { useCallback, useMemo, useState, useEffect } from 'react';
import { useDaemon } from './useDaemon';
import { httpGet } from './api';
import type {
  Artifact,
  FsResponse,
  InteractionMode,
  NodeTrackedState,
  RunMode,
  GlobalMode,
  VuhlpConfig,
  MainTab,
} from '@vuhlp/ui';
import {
  Button,
  Inspector,
  ResizableLayout,
  Sidebar,
  ThemeToggle,
  ThemePicker,
  useUIPackage,
  ApprovalQueue,
  PromptQueue,
  MainPane,
} from '@vuhlp/ui';
// Styles are imported in main.tsx

const DEFAULT_ROLES = ['investigator', 'planner', 'implementer', 'reviewer'];
const WORKSPACE_MODES = ['shared', 'worktree', 'copy'] as const;
type WorkspaceMode = (typeof WORKSPACE_MODES)[number];
const PROVIDER_FALLBACK = ['mock'];

function App() {
  const [uiPackage, setUIPackage] = useUIPackage();
  const {
    runs,
    providers,
    connStatus,
    createRun,
    stopRun,
    deleteRun,
    archiveRun,
    unarchiveRun,
    renameRun,
    pauseRun,
    resumeRun,
    getConfig,
    nodeLogs,
    saveConfig,
    getNodeTrackedState,
    pendingApprovals,
    approveRequest,
    denyRequest,
    modifyRequest,
    isLoadingRuns,
    isLoadingProviders,
    refreshRuns,
    // Chat methods
    sendChatMessage,
    queueChatMessage,
    setInteractionMode,
    getInteractionMode,
    getChatMessages,
    updateEdge,
    createEdge,
    deleteEdge,
    createNode,
    deleteNode,
    updateNode,
    // Run mode methods
    setRunMode,
    getRunMode,
    getRunPhase,
    // Global mode methods
    setGlobalMode,
    getGlobalMode,
    // CLI permissions methods
    getSkipCliPermissions,
    setSkipCliPermissions,
    // Prompt queue methods (Section 3.4)
    getPrompts,
    sendPrompt,
    cancelPrompt,
    addUserPrompt,
    modifyPrompt,
    stopNode,
    fetchEvents,
  } = useDaemon();
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  useEffect(() => {
    if (activeRunId) {
      fetchEvents(activeRunId);
    }
  }, [activeRunId, fetchEvents]);

  // File tabs state
  const [openTabs, setOpenTabs] = useState<MainTab[]>([{ type: 'graph' }]);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [editingConfig, setEditingConfig] = useState<VuhlpConfig | null>(null);
  const [providersJson, setProvidersJson] = useState("");
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [configLoadError, setConfigLoadError] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const activeRun = activeRunId ? runs[activeRunId] : null;

  // Default to root orchestrator node when no specific node is selected
  const effectiveNodeId = activeNodeId || activeRun?.rootOrchestratorNodeId || null;
  const activeNode = activeRun && effectiveNodeId && activeRun.nodes ? activeRun.nodes[effectiveNodeId] : null;

  const activeNodeLogs = (activeRunId && effectiveNodeId && nodeLogs[activeRunId]?.[effectiveNodeId]) || [];

  const activeTrackedState: NodeTrackedState | undefined = useMemo(() => {
    if (!activeRunId || !effectiveNodeId) return undefined;
    return getNodeTrackedState(activeRunId, effectiveNodeId);
  }, [activeRunId, effectiveNodeId, getNodeTrackedState]);

  const activeArtifacts = useMemo(() => {
    if (!activeRun || !effectiveNodeId || !activeRun.artifacts) return [];
    return Object.values(activeRun.artifacts)
      .filter((a: Artifact) => a.nodeId === effectiveNodeId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [activeRun, effectiveNodeId]);

  // Chat state
  const activeChatMessages = useMemo(() => {
    if (!activeRunId) return [];
    return getChatMessages(activeRunId);
  }, [activeRunId, getChatMessages]);

  const activeInteractionMode = useMemo(() => {
    if (!activeRunId) return 'autonomous' as const;
    return getInteractionMode(activeRunId);
  }, [activeRunId, getInteractionMode]);

  const activeRunMode = useMemo(() => {
    if (!activeRunId) return 'AUTO' as const;
    return getRunMode(activeRunId);
  }, [activeRunId, getRunMode]);

  const activeRunPhase = useMemo(() => {
    if (!activeRunId) return null;
    return getRunPhase(activeRunId);
  }, [activeRunId, getRunPhase]);

  const activeGlobalMode = useMemo(() => {
    if (!activeRunId) return 'PLANNING' as const;
    return getGlobalMode(activeRunId);
  }, [activeRunId, getGlobalMode]);

  const activeSkipCliPermissions = useMemo(() => {
    if (!activeRunId) return true; // Default to skip
    return getSkipCliPermissions(activeRunId);
  }, [activeRunId, getSkipCliPermissions]);

  // Prompt queue state (Section 3.4)
  const activePrompts = useMemo(() => {
    if (!activeRunId) return [];
    return getPrompts(activeRunId);
  }, [activeRunId, getPrompts]);

  const isRunActive = activeRun?.status === 'running' || activeRun?.status === 'paused';

  const signalDirty = () => {
    setSaveError(null);
    setSaveSuccess(null);
  };

  const updateEditingConfig = (updater: (base: VuhlpConfig) => VuhlpConfig) => {
    setEditingConfig((prev) => {
      const base = prev ?? {};
      return updater(base);
    });
  };

  const resetConfigForm = () => {
    setEditingConfig(null);
    setProvidersJson("");
    setProvidersError(null);
    setConfigLoadError(null);
    setSaveError(null);
    setSaveSuccess(null);
  };

  const openConfigPanel = async () => {
    setShowConfig(true);
    resetConfigForm();
    try {
      const data = await getConfig();
      const nextConfig = JSON.parse(JSON.stringify(data.config ?? {})) as VuhlpConfig;
      setEditingConfig(nextConfig);
      setProvidersJson(JSON.stringify(nextConfig.providers ?? {}, null, 2));
    } catch (error: unknown) {
      console.error(error);
      const message =
        error instanceof Error ? error.message : 'Failed to load configuration.';
      setConfigLoadError(message);
    }
  };

  const closeConfigPanel = () => {
    setShowConfig(false);
    resetConfigForm();
  };

  const toggleConfigPanel = () => {
    if (showConfig) {
      closeConfigPanel();
    } else {
      void openConfigPanel();
    }
  };

  const handleFetchFs = useCallback(async (path: string, includeFiles?: boolean): Promise<FsResponse> => {
    const params = new URLSearchParams({ path });
    if (includeFiles) {
      params.set('includeFiles', 'true');
    }
    return await httpGet(`/api/system/fs?${params.toString()}`) as FsResponse;
  }, []);

  const handleOpenFile = useCallback(async (filePath: string) => {
    // Check if file is already open
    const existingIndex = openTabs.findIndex(
      (tab) => tab.type === 'file' && tab.path === filePath
    );
    if (existingIndex >= 0) {
      setActiveTabIndex(existingIndex);
      return;
    }

    // Fetch file content
    try {
      const response = await httpGet(`/api/system/fs/read?path=${encodeURIComponent(filePath)}`) as { content: string };
      const newTab: MainTab = { type: 'file', path: filePath, content: response.content };
      setOpenTabs((prev) => [...prev, newTab]);
      setActiveTabIndex(openTabs.length);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  }, [openTabs]);

  const handleCloseTab = useCallback((index: number) => {
    // Don't close the graph tab
    const tab = openTabs[index];
    if (tab.type === 'graph') return;

    const newTabs = openTabs.filter((_, i) => i !== index);
    setOpenTabs(newTabs);

    // Adjust active tab if needed
    if (activeTabIndex >= newTabs.length) {
      setActiveTabIndex(Math.max(0, newTabs.length - 1));
    } else if (activeTabIndex > index) {
      setActiveTabIndex(activeTabIndex - 1);
    }
  }, [openTabs, activeTabIndex]);

  const parseNumberInput = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  const handleRoleChange = (role: string, value: string) => {
    signalDirty();
    updateEditingConfig((base) => {
      const nextRoles = { ...(base.roles ?? {}) };
      if (value) {
        nextRoles[role] = value;
      } else {
        delete nextRoles[role];
      }
      return { ...base, roles: nextRoles };
    });
  };

  const handleCommandChange = (index: number, value: string) => {
    signalDirty();
    updateEditingConfig((base) => {
      const currentCommands = base.verification?.commands ?? [];
      const nextCommands = [...currentCommands];
      nextCommands[index] = value;
      return {
        ...base,
        verification: {
          ...(base.verification ?? {}),
          commands: nextCommands,
        },
      };
    });
  };

  const addCommand = () => {
    signalDirty();
    updateEditingConfig((base) => {
      const currentCommands = base.verification?.commands ?? [];
      return {
        ...base,
        verification: {
          ...(base.verification ?? {}),
          commands: [...currentCommands, ""],
        },
      };
    });
  };

  const removeCommand = (index: number) => {
    signalDirty();
    setEditingConfig((prev) => {
      const base = prev ?? {};
      const currentCommands = base.verification?.commands ?? [];
      if (index >= currentCommands.length) return prev;
      const nextCommands = currentCommands.filter((_, idx) => idx !== index);
      return {
        ...base,
        verification: {
          ...(base.verification ?? {}),
          commands: nextCommands,
        },
      };
    });
  };

  const handleProvidersJsonChange = (value: string) => {
    signalDirty();
    setProvidersJson(value);
    setProvidersError(null);
  };

  const handleSaveConfig = async () => {
    if (!editingConfig) return;
    setProvidersError(null);
    setSaveError(null);
    setSaveSuccess(null);

    let parsedProviders: Record<string, unknown> = {};
    if (providersJson.trim()) {
      try {
        const candidate = JSON.parse(providersJson);
        if (!candidate || Array.isArray(candidate) || typeof candidate !== "object") {
          throw new Error("Providers configuration must be an object.");
        }
        parsedProviders = candidate as Record<string, unknown>;
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : "Invalid JSON for providers section.";
        setProvidersError(message);
        return;
      }
    }

    setSavingConfig(true);
    try {
      const payload = { ...editingConfig, providers: parsedProviders };
      const data = await saveConfig(payload);
      const nextConfig = JSON.parse(JSON.stringify(data.config ?? {})) as VuhlpConfig;
      setEditingConfig(nextConfig);
      setProvidersJson(JSON.stringify(nextConfig.providers ?? {}, null, 2));
      setSaveSuccess("Configuration profiles updated and applied to session");
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to save configuration.";
      setSaveError(message);
    } finally {
      setSavingConfig(false);
    }
  };

  const roleList = Array.from(new Set([
    ...(editingConfig?.roles ? Object.keys(editingConfig.roles) : []),
    ...DEFAULT_ROLES,
  ]));
  const providerOptions = editingConfig?.providers ? Object.keys(editingConfig.providers) : [];
  const providerSelectOptions = providerOptions.length ? providerOptions : PROVIDER_FALLBACK;
  const verificationCommands = editingConfig?.verification?.commands ?? [];
  // Config modal now uses CSS classes from brutalist-ui (vuhlp-config*)

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header className="vuhlp-topbar">
        <div className="vuhlp-brand">
          <div className="vuhlp-logo">v</div>
          <div>
            <div className="vuhlp-title">vuhlp code</div>
            <div className="vuhlp-subtitle">v0 orchestration harness</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div className="vuhlp-status">{connStatus}</div>
          <Button variant="secondary" onClick={toggleConfigPanel}>Config</Button>
          <ThemePicker currentPackage={uiPackage} onPackageChange={setUIPackage} />
          <ThemeToggle />
        </div>
      </header>

      {showConfig && (
        <div className="vuhlp-configOverlay" onClick={closeConfigPanel}>
          <div className="vuhlp-configPanel" onClick={e => e.stopPropagation()}>
            <h2>System Configuration</h2>

            {configLoadError ? (
              <div className="vuhlp-configLoading vuhlp-configError">
                {configLoadError}
              </div>
            ) : !editingConfig ? (
              <div className="vuhlp-configLoading">Loading configuration...</div>
            ) : (
              <div className="vuhlp-configGrid">
                <section className="vuhlp-configSection">
                  <h3 className="vuhlp-configSectionHeader">Agent Roles</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {roleList.map((role) => (
                      <div key={role} className="vuhlp-configField">
                        <span className="vuhlp-configFieldLabel">{role}</span>
                        <select
                          value={editingConfig.roles?.[role] ?? ''}
                          onChange={(evt) => handleRoleChange(role, evt.target.value)}
                          className="vuhlp-configSelect"
                        >
                          <option value="">Select provider</option>
                          {providerSelectOptions.map((p) => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="vuhlp-configSection">
                  <h3 className="vuhlp-configSectionHeader">Core Settings</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
                    <label className="vuhlp-configField">
                      <span className="vuhlp-configFieldLabel">Data Directory</span>
                      <input
                        value={editingConfig.dataDir ?? ''}
                        onChange={(evt) => {
                          signalDirty();
                          updateEditingConfig((base) => ({ ...base, dataDir: evt.target.value }));
                        }}
                        className="vuhlp-configInput"
                      />
                    </label>
                    <label className="vuhlp-configField">
                      <span className="vuhlp-configFieldLabel">Server Port</span>
                      <input
                        type="number"
                        value={editingConfig.server?.port ?? ''}
                        onChange={(evt) => {
                          signalDirty();
                          const parsed = parseNumberInput(evt.target.value);
                          updateEditingConfig((base) => ({
                            ...base,
                            server: { ...(base.server ?? {}), port: parsed },
                          }));
                        }}
                        className="vuhlp-configInput"
                      />
                    </label>
                    <label className="vuhlp-configField">
                      <span className="vuhlp-configFieldLabel">Workspace Mode</span>
                      <select
                        value={editingConfig.workspace?.mode ?? WORKSPACE_MODES[0]}
                        onChange={(evt) => {
                          signalDirty();
                          const nextMode = evt.target.value as WorkspaceMode;
                          updateEditingConfig((base) => ({
                            ...base,
                            workspace: { ...(base.workspace ?? {}), mode: nextMode },
                          }));
                        }}
                        className="vuhlp-configSelect"
                      >
                        {WORKSPACE_MODES.map((mode) => (
                          <option key={mode} value={mode}>{mode}</option>
                        ))}
                      </select>
                    </label>
                    <label className="vuhlp-configField">
                      <span className="vuhlp-configFieldLabel">Workspace Root</span>
                      <input
                        value={editingConfig.workspace?.rootDir ?? ''}
                        onChange={(evt) => {
                          signalDirty();
                          updateEditingConfig((base) => ({
                            ...base,
                            workspace: {
                              ...(base.workspace ?? {}),
                              rootDir: evt.target.value,
                            },
                          }));
                        }}
                        className="vuhlp-configInput"
                      />
                    </label>
                  </div>
                </section>

                <section className="vuhlp-configSection">
                  <h3 className="vuhlp-configSectionHeader">Limits & Tuning</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <label className="vuhlp-configField">
                      <span className="vuhlp-configFieldLabel">Max Concurrency</span>
                      <input
                        type="number"
                        value={editingConfig.scheduler?.maxConcurrency ?? ''}
                        onChange={(evt) => {
                          signalDirty();
                          const parsed = parseNumberInput(evt.target.value);
                          updateEditingConfig((base) => ({
                            ...base,
                            scheduler: {
                              ...(base.scheduler ?? {}),
                              maxConcurrency: parsed,
                            },
                          }));
                        }}
                        className="vuhlp-configInput"
                      />
                    </label>
                    <label className="vuhlp-configField">
                      <span className="vuhlp-configFieldLabel">Max Iterations</span>
                      <input
                        type="number"
                        value={editingConfig.orchestration?.maxIterations ?? ''}
                        onChange={(evt) => {
                          signalDirty();
                          const parsed = parseNumberInput(evt.target.value);
                          updateEditingConfig((base) => ({
                            ...base,
                            orchestration: {
                              ...(base.orchestration ?? {}),
                              maxIterations: parsed,
                            },
                          }));
                        }}
                        className="vuhlp-configInput"
                      />
                    </label>
                  </div>
                </section>

                <section className="vuhlp-configSection">
                  <h3 className="vuhlp-configSectionHeader">Verification Commands</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {verificationCommands.length === 0 ? (
                      <div className="vuhlp-configEmptyHint">No commands configured</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {verificationCommands.map((cmd: string, index: number) => (
                          <div key={index} className="vuhlp-configCommandRow">
                            <input
                              value={cmd}
                              onChange={(evt) => handleCommandChange(index, evt.target.value)}
                              className="vuhlp-configInput"
                            />
                            <button
                              type="button"
                              onClick={() => removeCommand(index)}
                              className="vuhlp-configRemoveBtn"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <Button variant="secondary" onClick={addCommand}>Add command</Button>
                  </div>
                </section>

                <section className="vuhlp-configSection full-width">
                  <h3 className="vuhlp-configSectionHeader">Configured Providers</h3>
                  <textarea value={providersJson} onChange={(evt) => handleProvidersJsonChange(evt.target.value)} className="vuhlp-configTextarea" />
                  {providersError && (
                    <div className="vuhlp-configError" style={{ marginTop: '0.5rem' }}>
                      {providersError}
                    </div>
                  )}
                </section>
              </div>
            )}

            <div className="vuhlp-configFooter">
              <div className="vuhlp-configActions">
                <Button variant="secondary" onClick={closeConfigPanel}>Close</Button>
                <Button
                  variant="primary"
                  onClick={handleSaveConfig}
                  disabled={savingConfig || !editingConfig || Boolean(providersError)}
                >
                  {savingConfig ? 'Saving…' : 'Save configuration'}
                </Button>
              </div>
              <div className="vuhlp-configMessages">
                {saveError && <span className="vuhlp-configError">{saveError}</span>}
                {saveSuccess && <span className="vuhlp-configSuccess">{saveSuccess}</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      <ResizableLayout
        className="vuhlp-layout-container"
        maxInspectorWidth={4000}
        sidebar={
        <Sidebar
          runs={Object.values(runs)}
          providers={providers}
          activeRunId={activeRunId}
          onSelectRun={(id: string) => { setActiveRunId(id); setActiveNodeId(null); }}
          onDeleteRun={async (id: string) => {
            if (activeRunId === id) {
              setActiveRunId(null);
              setActiveNodeId(null);
            }
            await deleteRun(id);
          }}
          onArchiveRun={async (id: string) => {
            if (activeRunId === id) {
              setActiveRunId(null);
              setActiveNodeId(null);
            }
            await archiveRun(id);
          }}
          onUnarchiveRun={async (id: string) => {
            await unarchiveRun(id);
          }}
          onRenameRun={(id: string, name: string) => {
            renameRun(id, name);
          }}
          onCreateRun={async (prompt: string, repoPath: string) => {
              const id = await createRun(prompt, repoPath);
              setActiveRunId(id);
              setActiveNodeId(null);
              return id;
          }}
          onFetchFs={handleFetchFs}
          onOpenFile={handleOpenFile}
          onFilterChange={(filter) => {
            refreshRuns(filter === 'all');
          }}
          isLoadingRuns={isLoadingRuns}
          isLoadingProviders={isLoadingProviders}
        />
        }
        main={
          <MainPane
            run={activeRun}
            onNodeSelect={setActiveNodeId}
            selectedNodeId={activeNodeId}
            onEdgeUpdate={(edgeId, updates) => {
              if (activeRunId) {
                updateEdge(activeRunId, edgeId, updates);
              }
            }}
            onEdgeCreate={(sourceId, targetId) => {
              if (activeRunId) {
                createEdge(activeRunId, sourceId, targetId);
              }
            }}
            onEdgeDelete={(edgeId) => {
              if (activeRunId) {
                deleteEdge(activeRunId, edgeId);
              }
            }}
            onNodeCreate={(providerId, label) => {
               if (activeRunId) {
                 createNode(activeRunId, providerId, { label, control: 'MANUAL', role: 'implementer' });
               }
            }}
            onNodeDelete={(nodeId) => {
              if (activeRunId) {
                deleteNode(activeRunId, nodeId);
              }
            }}
            onStop={() => activeRunId && stopRun(activeRunId)}
            onPause={() => activeRunId && pauseRun(activeRunId)}
            onResume={(feedback?: string) => activeRunId && resumeRun(activeRunId, feedback)}
            onStopNode={(nodeId) => activeRunId && stopNode(activeRunId, nodeId)}
            interactionMode={activeInteractionMode}
            onInteractionModeChange={(mode: InteractionMode) => {
              if (activeRunId) setInteractionMode(activeRunId, mode);
            }}
            runMode={activeRunMode}
            onRunModeChange={(mode: RunMode) => {
              if (activeRunId) setRunMode(activeRunId, mode);
            }}
            globalMode={activeGlobalMode}
            onGlobalModeChange={(mode: GlobalMode) => {
              if (activeRunId) setGlobalMode(activeRunId, mode);
            }}
            skipCliPermissions={activeSkipCliPermissions}
            onSkipCliPermissionsChange={(skip: boolean) => {
              if (activeRunId) setSkipCliPermissions(activeRunId, skip);
            }}
            runPhase={activeRunPhase}
            getNodeTrackedState={getNodeTrackedState}
            onNodeMessage={(nodeId, content) => {
              if (activeRunId) {
                sendChatMessage(activeRunId, content, { nodeId, interrupt: true });
              }
            }}
            openTabs={openTabs}
            activeTabIndex={activeTabIndex}
            onTabChange={setActiveTabIndex}
            onCloseTab={handleCloseTab}
          />
        }
        inspector={
          <Inspector
            node={activeNode || null}
            logs={activeNodeLogs}
            artifacts={activeArtifacts}
            runId={activeRunId || undefined}
            trackedState={activeTrackedState}
            canSendMessage={isRunActive}
            // Context-aware chat: shows who you're chatting with
            chatTarget={activeNode ? {
              type: activeNodeId ? 'node' : 'orchestrator',
              nodeId: effectiveNodeId || undefined,
              label: activeNode?.label || 'Orchestrator'
            } : undefined}
            chatMessages={activeChatMessages}
            onSendMessage={(content: string, interrupt: boolean) => {
              if (activeRunId) {
                // If user explicitly selected a node, target that node; otherwise target orchestrator (no nodeId)
                sendChatMessage(activeRunId, content, { nodeId: activeNodeId || undefined, interrupt });
              }
            }}
            onQueueMessage={(content: string) => {
              if (activeRunId) {
                queueChatMessage(activeRunId, content, activeNodeId || undefined);
              }
            }}
            nodes={activeRun ? Object.values(activeRun.nodes || {}) : []}
            edges={activeRun ? Object.values(activeRun.edges || {}) : []}
            onAddConnection={(sourceId, targetId) => {
              if (activeRunId) {
                createEdge(activeRunId, sourceId, targetId);
              }
            }}
            onRemoveConnection={(edgeId) => {
              if (activeRunId) {
                deleteEdge(activeRunId, edgeId);
              }
            }}
            onGroupChanges={() => {
              if (activeRunId) {
                const prompt = "Please review the pending file changes, group them by feature, and create git commits for each feature.";
                sendChatMessage(activeRunId, prompt, { nodeId: activeNodeId || undefined, interrupt: true });
              }
            }}
            providers={providers}
            onUpdateNode={updateNode}
            isGitRepo={activeRun?.repoFacts?.isGitRepo}
          />
        }
      />

      <ApprovalQueue
        approvals={pendingApprovals}
        onApprove={approveRequest}
        onDeny={denyRequest}
        onModify={modifyRequest}
      />

      {/* Prompt Queue Panel - Section 3.4: INTERACTIVE mode prompt review */}
      {activeRunId && activeRunMode === 'INTERACTIVE' && (
        <PromptQueue
          prompts={activePrompts}
          runId={activeRunId}
          onSendPrompt={(promptId) => sendPrompt(activeRunId, promptId)}
          onCancelPrompt={(promptId) => cancelPrompt(activeRunId, promptId)}
          onEditPrompt={(promptId, newContent) => modifyPrompt(activeRunId, promptId, newContent)}
          onCreatePrompt={(content, targetNodeId) => addUserPrompt(activeRunId, content, targetNodeId)}
          className="vuhlp-promptQueueOverlay"
        />
      )}
    </div>
  );
}

export default App;
