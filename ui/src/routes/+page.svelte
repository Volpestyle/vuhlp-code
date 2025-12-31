<script>
  import { onMount } from 'svelte';

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  let runs = [];
  let sessions = [];
  let models = [];
  let policy = {};
  let policyDraft = {
    require_tools: false,
    require_vision: false,
    max_cost_usd: '',
    preferred_models: []
  };

  let selectedRun = null;
  let runDetail = null;
  let selectedSession = null;
  let runEvents = [];
  let sessionEvents = [];
  let toolCallMeta = {};
  let sessionData = null;
  let streamingText = '';
  let showSessionLogs = false;
  let sessionLogText = '';
  let sessionLogError = '';
  let sessionLogCount = 0;
  let sessionLogFetchedAt = '';
  let isLoadingLogs = false;

  let runStream = null;
  let sessionStream = null;

  let workspacePath = '';
  let specPath = '';
  let sessionMode = 'chat';
  let sessionSystem = '';

  let chatText = '';
  let toolCallId = '';
  let approvalTurnId = '';
  let stepId = '';
  let isWaitingForModel = false;

  let providerFilter = '';
  let selectedModel = '';
  let modelInitialized = false;

  let lastRunRefresh = '';
  let lastSessionRefresh = '';

  // Panel widths
  let leftPanelWidth = 260;
  let rightPanelWidth = 240;
  let isResizingLeft = false;
  let isResizingRight = false;

  const stamp = () => new Date().toLocaleTimeString();

  onMount(() => {
    if (typeof window !== 'undefined') {
      workspacePath = localStorage.getItem('workspace') || '';
      specPath = localStorage.getItem('specPath') || '';
      
      // Load panel widths
      const savedLeft = localStorage.getItem('leftPanelWidth');
      const savedRight = localStorage.getItem('rightPanelWidth');
      if (savedLeft) leftPanelWidth = parseInt(savedLeft, 10);
      if (savedRight) rightPanelWidth = parseInt(savedRight, 10);
    }
    refreshAll();
    const interval = setInterval(() => {
      refreshRuns();
      refreshSessions();
    }, 5000);

    // Panel resize handlers
    const handleMouseMove = (e) => {
      if (isResizingLeft) {
        leftPanelWidth = Math.max(180, Math.min(400, e.clientX));
        localStorage.setItem('leftPanelWidth', leftPanelWidth.toString());
      }
      if (isResizingRight) {
        rightPanelWidth = Math.max(180, Math.min(400, window.innerWidth - e.clientX));
        localStorage.setItem('rightPanelWidth', rightPanelWidth.toString());
      }
    };

    const handleMouseUp = () => {
      isResizingLeft = false;
      isResizingRight = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      clearInterval(interval);
      if (runStream) runStream.close();
      if (sessionStream) sessionStream.close();
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  });

  function startResizeLeft() {
    isResizingLeft = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }

  function startResizeRight() {
    isResizingRight = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }

  async function refreshAll() {
    await Promise.all([refreshRuns(), refreshSessions(), refreshModels()]);
  }

  async function refreshRuns() {
    const res = await fetch(baseUrl + '/v1/runs');
    if (!res.ok) return;
    runs = await res.json();
    if (selectedRun) {
      const updated = runs.find((run) => run.id === selectedRun.id);
      if (updated) selectedRun = updated;
    }
    lastRunRefresh = stamp();
  }

  async function refreshSessions() {
    const res = await fetch(baseUrl + '/v1/sessions');
    if (!res.ok) return;
    sessions = await res.json();
    if (selectedSession) {
      const updated = sessions.find((session) => session.id === selectedSession.id);
      if (updated) selectedSession = updated;
    }
    lastSessionRefresh = stamp();
  }

  async function refreshModels() {
    const res = await fetch(baseUrl + '/v1/models');
    if (!res.ok) return;
    const data = await res.json();
    models = data.models || [];
    policy = data.policy || {};
    policyDraft = {
      require_tools: !!policy.require_tools,
      require_vision: !!policy.require_vision,
      max_cost_usd: policy.max_cost_usd ?? '',
      preferred_models: policy.preferred_models || []
    };
    if (policyDraft.preferred_models[0]) {
      selectedModel = policyDraft.preferred_models[0];
      providerFilter = selectedModel.includes(':') ? selectedModel.split(':')[0] : '';
    }
    modelInitialized = true;
  }

  // Auto-save model when selection changes
  $: if (modelInitialized && selectedModel !== undefined) {
    autoSaveModel();
  }

  async function autoSaveModel() {
    const preferred = selectedModel ? [selectedModel] : [];
    if (JSON.stringify(preferred) === JSON.stringify(policyDraft.preferred_models)) return;
    policyDraft.preferred_models = preferred;
    const maxCost = Number(policyDraft.max_cost_usd);
    const maxCostValue = Number.isFinite(maxCost) ? maxCost : null;
    await fetch(baseUrl + '/v1/model-policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        require_tools: policyDraft.require_tools,
        require_vision: policyDraft.require_vision,
        max_cost_usd: maxCostValue,
        preferred_models: preferred
      })
    });
  }

  async function loadRunDetail() {
    if (!selectedRun) return;
    const res = await fetch(`${baseUrl}/v1/runs/${selectedRun.id}`);
    if (!res.ok) return;
    runDetail = await res.json();
  }

  async function selectRun(run) {
    selectedRun = run;
    selectedSession = null;
    sessionData = null;
    showSessionLogs = false;
    sessionLogText = '';
    sessionLogError = '';
    sessionLogCount = 0;
    sessionLogFetchedAt = '';
    isLoadingLogs = false;
    isLoadingLogs = false;
    if (sessionStream) sessionStream.close();
    sessionStream = null;
    runDetail = null;
    runEvents = [];
    await loadRunDetail();
    if (runStream) runStream.close();
    runStream = new EventSource(`${baseUrl}/v1/runs/${run.id}/events`);
    runStream.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data);
        runEvents = [...runEvents.slice(-299), ev];
      } catch (err) {}
    };
  }

  async function selectSession(session) {
    selectedSession = session;
    selectedRun = null;
    runEvents = [];
    sessionEvents = [];
    toolCallMeta = {};
    showSessionLogs = false;
    sessionLogText = '';
    sessionLogError = '';
    sessionLogCount = 0;
    sessionLogFetchedAt = '';
    if (runStream) runStream.close();
    runStream = null;
    streamingText = '';
    isWaitingForModel = false;
    await loadSession();
    if (sessionStream) sessionStream.close();
    sessionStream = new EventSource(`${baseUrl}/v1/sessions/${session.id}/events`);
    sessionStream.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data);
        handleSessionEvent(ev);
      } catch (err) {}
    };
  }

  async function loadSession() {
    if (!selectedSession) return;
    const res = await fetch(`${baseUrl}/v1/sessions/${selectedSession.id}`);
    if (!res.ok) return;
    sessionData = await res.json();
  }

  function handleSessionEvent(ev) {
    recordSessionEvent(ev);
    if (ev.type === 'turn_started') {
      isWaitingForModel = true;
      return;
    }
    if (ev.type === 'model_output_delta' && ev.data && ev.data.delta) {
      isWaitingForModel = false;
      streamingText += ev.data.delta;
      return;
    }
    if (ev.type === 'message_added') {
      if (ev.data && ev.data.role === 'assistant') {
        isWaitingForModel = false;
        streamingText = '';
      }
      loadSession();
      return;
    }
    if (ev.type === 'tool_call_started' && ev.data && ev.data.tool_call_id) {
      toolCallId = ev.data.tool_call_id;
      approvalTurnId = ev.data.turn_id || approvalTurnId;
    }
    if (
      ev.type === 'error' ||
      ev.type === 'turn_completed' ||
      ev.type === 'session_completed' ||
      ev.type === 'session_failed' ||
      ev.type === 'session_canceled'
    ) {
      isWaitingForModel = false;
    }
  }

  function recordSessionEvent(ev) {
    if (!ev) return;
    sessionEvents = [...sessionEvents.slice(-299), ev];
    const data = ev.data || {};
    const callId = data.tool_call_id || data.toolCallId;
    if (!callId) return;
    const prev = toolCallMeta[callId] || { id: callId };
    const next = { ...prev };
    if (data.tool) next.tool = data.tool;
    if (ev.type === 'approval_requested') next.status = 'waiting';
    if (ev.type === 'approval_granted') next.status = 'approved';
    if (ev.type === 'approval_denied') next.status = 'denied';
    if (ev.type === 'tool_call_started') next.status = 'running';
    if (ev.type === 'tool_call_completed') {
      next.status = data.ok ? 'ok' : 'error';
      if (typeof data.ok === 'boolean') next.ok = data.ok;
      if (data.error) next.error = data.error;
    }
    toolCallMeta = { ...toolCallMeta, [callId]: next };
  }

  async function createRun() {
    if (!workspacePath.trim()) return alert('workspace path required');
    if (!specPath.trim()) return alert('spec path required');
    const payload = {
      workspace_path: workspacePath.trim(),
      spec_path: specPath.trim()
    };
    const res = await fetch(baseUrl + '/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const txt = await res.text();
      return alert('create failed: ' + txt);
    }
    localStorage.setItem('workspace', workspacePath.trim());
    localStorage.setItem('specPath', specPath.trim());
    refreshRuns();
  }

  async function cancelRun() {
    if (!selectedRun) return alert('select a run first');
    await fetch(`${baseUrl}/v1/runs/${selectedRun.id}/cancel`, { method: 'POST' });
    refreshRuns();
  }

  function exportRun() {
    if (!selectedRun) return alert('select a run first');
    window.open(`${baseUrl}/v1/runs/${selectedRun.id}/export`, '_blank');
  }

  async function createSession() {
    if (!workspacePath.trim()) return alert('workspace path required');
    const payload = {
      workspace_path: workspacePath.trim(),
      system_prompt: sessionSystem,
      mode: sessionMode
    };
    if (specPath.trim()) payload.spec_path = specPath.trim();
    const res = await fetch(baseUrl + '/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const txt = await res.text();
      return alert('create failed: ' + txt);
    }
    localStorage.setItem('workspace', workspacePath.trim());
    localStorage.setItem('specPath', specPath.trim());
    refreshSessions();
  }

  async function cancelSession() {
    if (!selectedSession) return alert('select a session first');
    await fetch(`${baseUrl}/v1/sessions/${selectedSession.id}/cancel`, { method: 'POST' });
    refreshSessions();
  }

  async function sendMessage() {
    if (!selectedSession) return alert('select a session first');
    if (!chatText.trim()) return alert('enter a message');
    isWaitingForModel = true;
    const res = await fetch(`${baseUrl}/v1/sessions/${selectedSession.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', parts: [{ type: 'text', text: chatText.trim() }], auto_run: true })
    });
    if (!res.ok) {
      isWaitingForModel = false;
      const txt = await res.text();
      return alert('send failed: ' + txt);
    }
    chatText = '';
  }

  async function approveStep() {
    if (!selectedRun) return alert('select a run first');
    if (!stepId.trim()) return alert('enter step_id');
    await fetch(`${baseUrl}/v1/runs/${selectedRun.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step_id: stepId.trim() })
    });
    stepId = '';
  }

  async function approveToolCall() {
    if (!selectedSession) return alert('select a session first');
    if (!toolCallId.trim()) return alert('enter tool_call_id');
    const payload = { tool_call_id: toolCallId.trim(), action: 'approve' };
    if (approvalTurnId.trim()) payload.turn_id = approvalTurnId.trim();
    await fetch(`${baseUrl}/v1/sessions/${selectedSession.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    toolCallId = '';
  }


  function formatParts(parts) {
    if (!parts) return '';
    return parts.map((p) => p.text || `[${p.type} ${p.ref || ''}]`).join('\n');
  }

  function formatToolParts(parts) {
    if (!parts) return '';
    return parts
      .map((p) => {
        if (p.text && p.text.trim() !== '') return p.text;
        if (p.ref && p.ref.trim() !== '') return `[${p.type} ${p.ref}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  function formatSessionLogs(events) {
    if (!events || events.length === 0) return 'no events recorded';
    return events
      .map((ev) => {
        const ts = ev.ts ? new Date(ev.ts).toLocaleString() : 'unknown';
        const header = [ts, ev.type, ev.turn_id ? `turn=${ev.turn_id}` : '', ev.message ? `msg=${ev.message}` : '']
          .filter(Boolean)
          .join(' | ');
        if (ev.data && Object.keys(ev.data).length) {
          return `${header}\n${JSON.stringify(ev.data, null, 2)}`;
        }
        return header;
      })
      .join('\n\n');
  }

  function toolStatusTone(meta) {
    if (!meta || !meta.status) return 'pending';
    switch (meta.status) {
      case 'waiting':
        return 'waiting';
      case 'approved':
        return 'active';
      case 'running':
        return 'running';
      case 'ok':
        return 'success';
      case 'error':
      case 'denied':
        return 'error';
      default:
        return 'pending';
    }
  }

  function toolStatusLabel(meta) {
    if (!meta || !meta.status) return 'queued';
    switch (meta.status) {
      case 'waiting':
        return 'awaiting approval';
      case 'approved':
        return 'approved';
      case 'running':
        return 'running';
      case 'ok':
        return 'ok';
      case 'error':
        return 'error';
      case 'denied':
        return 'denied';
      default:
        return meta.status;
    }
  }

  function tone(value) {
    if (!value) return 'idle';
    return value.toLowerCase().replace(/[^a-z]/g, '');
  }

  function shortId(id) {
    return id ? id.slice(0, 20) + '...' : '---';
  }

  async function refreshSessionLogs() {
    if (!selectedSession) return;
    isLoadingLogs = true;
    sessionLogError = '';
    try {
      const res = await fetch(`${baseUrl}/v1/sessions/${selectedSession.id}/events?format=json`);
      if (!res.ok) {
        const txt = await res.text();
        sessionLogError = `log fetch failed: ${txt}`;
        sessionLogText = '';
        sessionLogCount = 0;
        return;
      }
      const payload = await res.json();
      const events = Array.isArray(payload) ? payload : [];
      sessionLogCount = events.length;
      sessionLogText = formatSessionLogs(events);
      sessionLogFetchedAt = stamp();
    } catch (err) {
      sessionLogError = 'log fetch failed';
      sessionLogText = '';
      sessionLogCount = 0;
    } finally {
      isLoadingLogs = false;
    }
  }

  async function openSessionLogs() {
    if (!selectedSession) return;
    showSessionLogs = true;
    await refreshSessionLogs();
  }

  function closeSessionLogs() {
    showSessionLogs = false;
  }

  $: filteredModels = providerFilter
    ? models.filter((m) => m.provider === providerFilter)
    : models;
  $: activeView = selectedSession ? 'session' : selectedRun ? 'run' : null;
</script>

<svelte:head>
  <title>Agent Harness</title>
  <link
    rel="stylesheet"
    href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"
  />
</svelte:head>

<div class="app">
  <div class="bg-pattern"></div>
  
  <header class="topbar">
    <div class="brand">
      <div class="title">vuhlp-code</div>
      <div class="subtitle">local-first agent orchestration</div>
    </div>
    <div class="top-actions">
      <div class="pill">API: {baseUrl || 'n/a'}</div>
      <button class="ghost" on:click={refreshAll}>REFRESH</button>
    </div>
  </header>

  <section class="status-bar">
    <div class="stat">
      <span class="stat-label">RUNS</span>
      <span class="stat-value">{runs.length}</span>
    </div>
    <div class="stat">
      <span class="stat-label">SESSIONS</span>
      <span class="stat-value">{sessions.length}</span>
    </div>
    <div class="stat">
      <span class="stat-label">MODELS</span>
      <span class="stat-value">{models.length}</span>
    </div>
    <div class="stat">
      <span class="stat-label">ACTIVE</span>
      <span class="stat-value {activeView ? 'active' : ''}">{activeView || 'NONE'}</span>
    </div>
    <div class="stat">
      <span class="stat-label">MODEL</span>
      <span class="stat-value">{selectedModel ? selectedModel.split(':')[1]?.slice(0,12) || selectedModel.slice(0,12) : '---'}</span>
    </div>
  </section>

  <main class="layout" style="--left-width: {leftPanelWidth}px; --right-width: {rightPanelWidth}px;">
    <aside class="sidebar">
      <div class="card">
        <div class="card-header">
          <h3>Workspace</h3>
        </div>
        <div class="card-body">
          <div class="field">
            <label>PATH</label>
            <input bind:value={workspacePath} placeholder="/path/to/repo" />
          </div>
          <div class="field">
            <label>SPEC</label>
            <input bind:value={specPath} placeholder="specs/feature/spec.md" />
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3>Sessions</h3>
          <button class="small primary" on:click={createSession}>NEW</button>
        </div>
        <div class="card-body">
          <div class="inline-row">
            <select bind:value={sessionMode} class="small">
              <option value="chat">chat</option>
              <option value="spec">spec</option>
            </select>
            {#if selectedSession}
              <button class="small danger" on:click={cancelSession}>CANCEL</button>
            {/if}
          </div>
          <div class="list compact">
            {#each sessions.slice(0, 8) as session}
              <button
                class={`list-item ${selectedSession?.id === session.id ? 'active' : ''}`}
                on:click={() => selectSession(session)}
              >
                <span class="id">{shortId(session.id)}</span>
                <span class={`tag tone-${tone(session.status)}`}>{session.status}</span>
              </button>
            {/each}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3>Runs</h3>
          <button class="small primary" on:click={createRun}>START</button>
        </div>
        <div class="card-body">
          <div class="inline-row">
            {#if selectedRun}
              <button class="small" on:click={exportRun}>EXPORT</button>
              <button class="small danger" on:click={cancelRun}>CANCEL</button>
            {/if}
          </div>
          <div class="list compact">
            {#each runs.slice(0, 5) as run}
              <button
                class={`list-item ${selectedRun?.id === run.id ? 'active' : ''}`}
                on:click={() => selectRun(run)}
              >
                <span class="id">{shortId(run.id)}</span>
                <span class={`tag tone-${tone(run.status)}`}>{run.status}</span>
              </button>
            {/each}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3>Model</h3>
        </div>
        <div class="card-body">
          <div class="field">
            <label>PROVIDER</label>
            <select bind:value={providerFilter}>
              <option value="">any</option>
              {#each Array.from(new Set(models.map((m) => m.provider))).sort() as provider}
                <option value={provider}>{provider}</option>
              {/each}
            </select>
          </div>
          <div class="field">
            <label>MODEL</label>
            <select bind:value={selectedModel}>
              <option value="">select</option>
              {#each filteredModels as model}
                <option value={model.id}>{model.displayName || model.id}</option>
              {/each}
            </select>
          </div>
        </div>
      </div>
    </aside>

    <div class="resize-handle left" role="separator" aria-orientation="vertical" on:mousedown={startResizeLeft}></div>

    <section class="main-panel">
      {#if selectedSession}
        <div class="card full-height">
          <div class="card-header">
            <h3>Chat</h3>
            <div class="header-actions">
              <span class="meta">{selectedSession.id}</span>
              <button class="small icon-button" on:click={openSessionLogs} aria-label="View session logs" title="View session logs">
                <i class="fa-regular fa-file-lines" aria-hidden="true"></i>
              </button>
            </div>
          </div>
          <div class="chat-container">
            <div class="chat-messages">
              {#if sessionData?.messages}
                {#each sessionData.messages as msg}
                  {#if msg.role === 'tool'}
                    {@const meta = toolCallMeta[msg.tool_call_id] || {}}
                    {@const toolText = formatToolParts(msg.parts)}
                    <div class={`message ${msg.role}`}>
                      <div class="message-role">tool</div>
                      <div class="tool-meta">
                        <span class="tool-name">{meta.tool || 'tool'}</span>
                        <span class={`tag tone-${toolStatusTone(meta)}`}>{toolStatusLabel(meta)}</span>
                        <span class="tool-id">{msg.tool_call_id || meta.id || 'call_???'}</span>
                      </div>
                      {#if meta.error}
                        <div class="tool-error">{meta.error}</div>
                      {/if}
                      {#if toolText}
                        <div class="message-content">{toolText}</div>
                      {:else}
                        <div class="message-content muted">no output</div>
                      {/if}
                    </div>
                  {:else}
                    <div class={`message ${msg.role}`}>
                      <div class="message-role">{msg.role}</div>
                      <div class="message-content">{formatParts(msg.parts)}</div>
                    </div>
                  {/if}
                {/each}
              {/if}
              {#if isWaitingForModel}
                <div class="message assistant loading-state">
                  <div class="message-role">assistant</div>
                  <div class="loading-indicator">
                    <div class="loading-dots">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                    <span class="loading-text">thinking</span>
                  </div>
                </div>
              {:else if streamingText}
                <div class="message assistant streaming">
                  <div class="message-role">assistant <span class="blink">_</span></div>
                  <div class="message-content">{streamingText}</div>
                </div>
              {/if}
            </div>
            <div class="chat-input">
              <textarea 
                bind:value={chatText} 
                placeholder="Type a message..." 
                rows="2" 
                disabled={isWaitingForModel}
                on:keydown={(e) => e.key === 'Enter' && !e.shiftKey && !isWaitingForModel && (e.preventDefault(), sendMessage())}
              ></textarea>
              <button 
                class="primary" 
                on:click={sendMessage} 
                disabled={isWaitingForModel}
              >
                {#if isWaitingForModel}
                  SENDING
                {:else}
                  SEND
                {/if}
              </button>
            </div>
          </div>
        </div>
      {:else if selectedRun}
        <div class="card full-height">
          <div class="card-header">
            <h3>Run Events</h3>
            <span class="meta">{selectedRun.id}</span>
          </div>
          <div class="events-container">
            <div class="run-meta">
              <div class="meta-item"><span>STATUS</span><span class={`tag tone-${tone(selectedRun.status)}`}>{selectedRun.status}</span></div>
              <div class="meta-item"><span>MODEL</span><span>{selectedRun.model_canonical || '---'}</span></div>
              <div class="meta-item"><span>SPEC</span><span>{selectedRun.spec_path || '---'}</span></div>
            </div>
            <div class="events-list">
              {#each runEvents as ev}
                <div class="event-line">
                  <span class="event-ts">{ev.ts}</span>
                  <span class="event-type">{ev.type}</span>
                  <span class="event-msg">{ev.message || ''}</span>
                </div>
              {/each}
            </div>
          </div>
        </div>
      {:else}
        <div class="card full-height empty-state">
          <div class="empty-content">
            <div class="empty-icon">⚡</div>
            <h3>No Active Selection</h3>
            <p>Select a session or run from the sidebar, or create a new one.</p>
            <div class="empty-actions">
              <button class="primary" on:click={createSession}>New Session</button>
              <button on:click={createRun}>Start Run</button>
            </div>
          </div>
        </div>
      {/if}
    </section>

    <div class="resize-handle right" role="separator" aria-orientation="vertical" on:mousedown={startResizeRight}></div>

    <aside class="controls">
      <div class="card">
        <div class="card-header">
          <h3>Approvals</h3>
        </div>
        <div class="card-body">
          {#if selectedSession}
            <div class="field">
              <label>TOOL_CALL_ID</label>
              <input bind:value={toolCallId} placeholder="call_..." />
            </div>
            <div class="field">
              <label>TURN_ID</label>
              <input bind:value={approvalTurnId} placeholder="turn_..." />
            </div>
            <button class="primary full" on:click={approveToolCall}>APPROVE TOOL</button>
          {:else if selectedRun}
            <div class="field">
              <label>STEP_ID</label>
              <input bind:value={stepId} placeholder="step_..." />
            </div>
            <button class="primary full" on:click={approveStep}>APPROVE STEP</button>
          {:else}
            <p class="muted">Select a session or run to approve actions.</p>
          {/if}
        </div>
      </div>

      {#if selectedSession || selectedRun}
        <div class="card">
          <div class="card-header">
            <h3>Details</h3>
          </div>
          <div class="card-body">
            {#if selectedSession}
              <div class="detail-row"><span>MODE</span><span>{selectedSession.mode || 'chat'}</span></div>
              <div class="detail-row"><span>STATUS</span><span>{selectedSession.status}</span></div>
              <div class="detail-row"><span>MESSAGES</span><span>{sessionData?.messages?.length || 0}</span></div>
              <div class="detail-row"><span>STREAM</span><span>{sessionStream ? 'LIVE' : 'IDLE'}</span></div>
            {:else if selectedRun}
              <div class="detail-row"><span>STATUS</span><span>{selectedRun.status}</span></div>
              <div class="detail-row"><span>EVENTS</span><span>{runEvents.length}</span></div>
            {/if}
          </div>
        </div>
      {/if}
    </aside>
  </main>

  {#if showSessionLogs}
    <div class="modal-backdrop" on:click={closeSessionLogs}>
      <div class="modal" role="dialog" aria-modal="true" on:click|stopPropagation>
        <div class="modal-header">
          <div>
            <div class="modal-title">Session Logs</div>
            <div class="modal-subtitle">{selectedSession?.id || '---'}</div>
          </div>
          <div class="modal-actions">
            <button class="small" on:click={refreshSessionLogs} disabled={isLoadingLogs}>REFRESH</button>
            <button class="small" on:click={closeSessionLogs}>CLOSE</button>
          </div>
        </div>
        <div class="modal-body">
          <div class="log-meta">
            <span>EVENTS: {sessionLogCount}</span>
            <span>UPDATED: {sessionLogFetchedAt || '---'}</span>
          </div>
          {#if sessionLogError}
            <div class="log-error">{sessionLogError}</div>
          {/if}
          {#if isLoadingLogs}
            <div class="log-loading">loading logs...</div>
          {/if}
          <pre class="log-pane">{sessionLogText || 'no logs loaded'}</pre>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=VT323&display=swap');

  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    --bg-base: #09090b;
    --glass-bg: rgba(18, 18, 20, 0.8);
    --glass-border: rgba(255, 255, 255, 0.06);
    --glass-highlight: rgba(255, 255, 255, 0.02);
    --text-primary: #fafafa;
    --text-muted: #a1a1aa;
    --text-dim: #52525b;
    --accent: #22c55e;
    --accent-dim: rgba(34, 197, 94, 0.12);
    --accent-border: rgba(34, 197, 94, 0.3);
    --danger: #ef4444;
    --danger-dim: rgba(239, 68, 68, 0.12);
    --danger-border: rgba(239, 68, 68, 0.3);
    --warning: #f59e0b;
    --warning-dim: rgba(245, 158, 11, 0.12);
    margin: 0;
    padding: 0;
    color: var(--text-primary);
    background: var(--bg-base);
    font-family: 'IBM Plex Mono', Menlo, Monaco, 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.5;
  }

  .app {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .bg-pattern {
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background: 
      radial-gradient(ellipse 100% 100% at 50% 0%, rgba(34, 197, 94, 0.03) 0%, transparent 50%),
      repeating-linear-gradient(0deg, transparent, transparent 100px, rgba(255,255,255,0.01) 100px, rgba(255,255,255,0.01) 101px),
      repeating-linear-gradient(90deg, transparent, transparent 100px, rgba(255,255,255,0.01) 100px, rgba(255,255,255,0.01) 101px);
  }

  .topbar {
    position: sticky;
    top: 0;
    z-index: 100;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 20px;
    border-bottom: 1px solid var(--glass-border);
    background: var(--glass-bg);
    backdrop-filter: blur(20px);
  }

  .brand {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .title {
    font-family: 'VT323', monospace;
    font-size: 26px;
    font-weight: 400;
    letter-spacing: 0.05em;
    color: var(--accent);
  }

  .subtitle {
    font-size: 11px;
    color: var(--text-dim);
  }

  .top-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .pill {
    padding: 6px 10px;
    font-size: 11px;
    color: var(--text-dim);
    border: 1px solid var(--glass-border);
    background: rgba(0,0,0,0.3);
  }

  .status-bar {
    display: flex;
    gap: 1px;
    background: var(--glass-border);
    border-bottom: 1px solid var(--glass-border);
  }

  .status-bar .stat {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    background: var(--bg-base);
  }

  .status-bar .stat-label {
    font-size: 10px;
    color: var(--text-dim);
    letter-spacing: 0.05em;
  }

  .status-bar .stat-value {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
  }

  .status-bar .stat-value.active {
    color: var(--accent);
  }

  .layout {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: var(--left-width, 260px) 4px 1fr 4px var(--right-width, 240px);
    flex: 1;
    background: var(--bg-base);
  }

  .sidebar, .main-panel, .controls {
    background: var(--bg-base);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .resize-handle {
    background: var(--glass-border);
    cursor: ew-resize;
    transition: background 0.15s;
    position: relative;
  }

  .resize-handle:hover,
  .resize-handle:active {
    background: var(--accent-border);
  }

  .resize-handle::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 2px;
    height: 40px;
    background: rgba(255,255,255,0.1);
    border-radius: 1px;
  }

  .resize-handle:hover::after {
    background: var(--accent);
  }

  .card {
    background: var(--glass-bg);
    display: flex;
    flex-direction: column;
  }

  .card.full-height {
    flex: 1;
    min-height: 0;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 14px;
    border-bottom: 1px solid var(--glass-border);
  }

  .card-header h3 {
    margin: 0;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .card-header .meta {
    font-size: 10px;
    color: var(--text-dim);
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .card-body {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field label {
    font-size: 9px;
    color: var(--text-dim);
    letter-spacing: 0.08em;
  }

  input, select, textarea {
    font-family: inherit;
    font-size: 12px;
    padding: 8px 10px;
    border: 1px solid var(--glass-border);
    background: rgba(0,0,0,0.4);
    color: var(--text-primary);
    outline: none;
  }

  input:focus, select:focus, textarea:focus {
    border-color: var(--accent-border);
  }

  input::placeholder, textarea::placeholder {
    color: var(--text-dim);
  }

  select {
    cursor: pointer;
  }

  select.small {
    padding: 6px 8px;
    font-size: 11px;
  }

  button {
    font-family: inherit;
    font-size: 11px;
    padding: 8px 14px;
    border: 1px solid var(--glass-border);
    background: rgba(0,0,0,0.3);
    color: var(--text-muted);
    cursor: pointer;
    letter-spacing: 0.03em;
    transition: all 0.15s;
  }

  button:hover {
    background: rgba(255,255,255,0.05);
    border-color: rgba(255,255,255,0.1);
  }

  button.primary {
    background: var(--accent-dim);
    border-color: var(--accent-border);
    color: var(--accent);
  }

  button.primary:hover {
    background: rgba(34, 197, 94, 0.2);
  }

  button.danger {
    background: var(--danger-dim);
    border-color: var(--danger-border);
    color: var(--danger);
  }

  button.small {
    padding: 5px 10px;
    font-size: 10px;
  }

  button.icon-button {
    padding: 5px 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-primary);
  }

  button.icon-button i {
    font-size: 13px;
    line-height: 1;
  }

  button.full {
    width: 100%;
  }

  button.ghost {
    background: transparent;
    border-color: transparent;
  }

  .inline-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 200px;
    overflow-y: auto;
  }

  .list.compact {
    max-height: 160px;
  }

  .list::-webkit-scrollbar {
    width: 4px;
  }

  .list::-webkit-scrollbar-thumb {
    background: var(--glass-border);
  }

  .list-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 10px;
    background: rgba(0,0,0,0.2);
    border: 1px solid transparent;
    text-align: left;
    font-size: 11px;
  }

  .list-item:hover {
    background: rgba(255,255,255,0.02);
  }

  .list-item.active {
    border-color: var(--accent-border);
    background: var(--accent-dim);
  }

  .list-item .id {
    color: var(--text-muted);
    font-size: 10px;
  }

  .tag {
    font-size: 9px;
    padding: 2px 6px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    border: 1px solid var(--glass-border);
    background: rgba(0,0,0,0.3);
  }

  .tone-running, .tone-active {
    color: var(--accent);
    border-color: var(--accent-border);
    background: var(--accent-dim);
  }

  .tone-failed, .tone-error {
    color: var(--danger);
    border-color: var(--danger-border);
    background: var(--danger-dim);
  }

  .tone-completed, .tone-success {
    color: var(--accent);
    border-color: var(--accent-border);
    background: var(--accent-dim);
  }

  .tone-pending, .tone-waiting, .tone-waitingapproval {
    color: var(--warning);
    border-color: rgba(245, 158, 11, 0.3);
    background: var(--warning-dim);
  }

  .chat-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .chat-messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .chat-messages::-webkit-scrollbar {
    width: 6px;
  }

  .chat-messages::-webkit-scrollbar-thumb {
    background: var(--glass-border);
  }

  .message {
    padding: 12px;
    border: 1px solid var(--glass-border);
    background: rgba(0,0,0,0.2);
  }

  .message.assistant {
    background: var(--accent-dim);
    border-color: var(--accent-border);
  }

  .message.tool {
    background: var(--warning-dim);
    border-color: rgba(245, 158, 11, 0.3);
  }

  .message-role {
    font-size: 10px;
    color: var(--text-dim);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .tool-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin-bottom: 6px;
    font-size: 11px;
    color: var(--text-dim);
  }

  .tool-name {
    color: var(--warning);
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .tool-id {
    font-size: 10px;
    color: var(--text-dim);
    border: 1px solid var(--glass-border);
    background: rgba(0,0,0,0.25);
    padding: 2px 6px;
    border-radius: 999px;
  }

  .tool-error {
    color: var(--danger);
    font-size: 11px;
    margin-bottom: 6px;
    white-space: pre-wrap;
  }

  .message.assistant .message-role {
    color: var(--accent);
  }

  .message-content {
    font-size: 13px;
    white-space: pre-wrap;
    line-height: 1.6;
  }

  .chat-input {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--glass-border);
    background: rgba(0,0,0,0.2);
    align-items: center;
  }

  .chat-input textarea {
    flex: 1;
    resize: none;
    min-height: 40px;
  }

  .chat-input button {
  }

  .events-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .run-meta {
    display: flex;
    gap: 1px;
    background: var(--glass-border);
    border-bottom: 1px solid var(--glass-border);
  }

  .meta-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    background: var(--bg-base);
  }

  .meta-item span:first-child {
    font-size: 9px;
    color: var(--text-dim);
    letter-spacing: 0.05em;
  }

  .meta-item span:last-child {
    font-size: 11px;
    color: var(--text-muted);
  }

  .events-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    font-size: 11px;
  }

  .events-list::-webkit-scrollbar {
    width: 6px;
  }

  .events-list::-webkit-scrollbar-thumb {
    background: var(--glass-border);
  }

  .event-line {
    display: flex;
    gap: 12px;
    padding: 6px 0;
    border-bottom: 1px solid rgba(255,255,255,0.02);
  }

  .event-ts {
    color: var(--text-dim);
    font-size: 10px;
    flex-shrink: 0;
  }

  .event-type {
    color: var(--accent);
    flex-shrink: 0;
    min-width: 80px;
  }

  .event-msg {
    color: var(--text-muted);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .empty-content {
    text-align: center;
    padding: 40px;
  }

  .empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.3;
  }

  .empty-content h3 {
    margin: 0 0 8px 0;
    font-size: 14px;
    font-weight: 500;
    color: var(--text-muted);
  }

  .empty-content p {
    margin: 0 0 24px 0;
    font-size: 12px;
    color: var(--text-dim);
  }

  .empty-actions {
    display: flex;
    gap: 12px;
    justify-content: center;
  }

  .detail-row {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    font-size: 11px;
    border-bottom: 1px solid rgba(255,255,255,0.03);
  }

  .detail-row span:first-child {
    color: var(--text-dim);
    font-size: 10px;
    letter-spacing: 0.05em;
  }

  .detail-row span:last-child {
    color: var(--text-muted);
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .modal {
    width: min(980px, 96vw);
    max-height: 85vh;
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    display: flex;
    flex-direction: column;
    backdrop-filter: blur(18px);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--glass-border);
  }

  .modal-title {
    font-size: 12px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .modal-subtitle {
    font-size: 10px;
    color: var(--text-dim);
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .modal-actions {
    display: flex;
    gap: 8px;
  }

  .modal-body {
    flex: 1;
    min-height: 0;
    padding: 12px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .log-meta {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--text-dim);
    letter-spacing: 0.05em;
  }

  .log-error {
    color: var(--danger);
    font-size: 11px;
    border: 1px solid var(--danger-border);
    background: var(--danger-dim);
    padding: 8px 10px;
  }

  .log-loading {
    color: var(--text-dim);
    font-size: 11px;
  }

  .log-pane {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px;
    background: rgba(0,0,0,0.4);
    border: 1px solid var(--glass-border);
    font-size: 11px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .log-pane::-webkit-scrollbar {
    width: 6px;
  }

  .log-pane::-webkit-scrollbar-thumb {
    background: var(--glass-border);
  }

  .muted {
    font-size: 11px;
    color: var(--text-dim);
    margin: 0;
  }

  .blink {
    animation: blink 1s step-end infinite;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  .loading-state {
    background: transparent;
    border: 1px dashed var(--accent-border);
  }

  .loading-indicator {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .loading-dots {
    display: flex;
    gap: 4px;
  }

  .loading-dots span {
    width: 6px;
    height: 6px;
    background: var(--accent);
    animation: pulse 1.4s ease-in-out infinite;
  }

  .loading-dots span:nth-child(1) { animation-delay: 0s; }
  .loading-dots span:nth-child(2) { animation-delay: 0.2s; }
  .loading-dots span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes pulse {
    0%, 80%, 100% {
      opacity: 0.2;
      transform: scale(0.8);
    }
    40% {
      opacity: 1;
      transform: scale(1);
    }
  }

  .loading-text {
    font-size: 12px;
    color: var(--accent);
    letter-spacing: 0.1em;
    animation: fade-pulse 2s ease-in-out infinite;
  }

  @keyframes fade-pulse {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  textarea:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  @media (max-width: 1000px) {
    .layout {
      grid-template-columns: 1fr;
    }
    .resize-handle {
      display: none;
    }
  }
</style>
