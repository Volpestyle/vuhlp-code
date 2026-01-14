/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * Canonical vuhlp event + state types.
 *
 * v0 is intentionally conservative and stores provider-specific raw payloads
 * as artifacts to avoid throwing away information.
 */

export type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped" | "paused";

/**
 * Run phase from implementation_alignment.md section 2.1.
 * Determines which phase of the orchestration loop is active.
 */
export type RunPhase =
  | "BOOT"           // Load project, detect repo state, load docs index
  | "DOCS_ITERATION" // Triggered if docs are missing/insufficient
  | "INVESTIGATE"    // Repo scan, constraints, dependencies, existing tests
  | "PLAN"           // Create task DAG + acceptance criteria
  | "EXECUTE"        // Schedule ready tasks, run agents, merge results
  | "VERIFY"         // Run checks/tests/lints/build
  | "DOCS_SYNC"      // Update docs to match reality
  | "DONE";          // Export final report + updated docs + artifacts

/**
 * Global workflow context mode.
 * - PLANNING: Agents investigate, ask questions, and write to /docs only.
 * - IMPLEMENTATION: Agents can apply code changes.
 */
export type GlobalMode = "PLANNING" | "IMPLEMENTATION";

/**
 * Run-level orchestration mode.
 * - AUTO: Orchestrator schedules nodes, triggers agent turns, runs verification, retries/fix-loops automatically.
 * - INTERACTIVE: Orchestrator pauses scheduling; user manually drives prompts/approvals.
 */
export type RunMode = "AUTO" | "INTERACTIVE";

/**
 * Node-level control override.
 * - AUTO: Node follows run-level mode (default).
 * - MANUAL: Node requires manual triggering even in AUTO run mode.
 */
export type NodeControl = "AUTO" | "MANUAL";

export type NodeType = "orchestrator" | "task" | "verification" | "merge" | "join_gate" | "router";

/**
 * Node execution status.
 * - queued: Waiting to be scheduled.
 * - running: Currently executing.
 * - completed: Finished successfully.
 * - failed: Finished with error.
 * - skipped: Not executed (e.g., cancelled run).
 * - blocked_dependency: Waiting for dependent nodes to complete.
 * - blocked_approval: Waiting for user approval on a tool action.
 * - blocked_manual_input: Waiting for manual input in interactive mode.
 */
export type NodeStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "blocked_dependency"
  | "blocked_approval"
  | "blocked_manual_input";

export type TriggerMode = "any_input" | "all_inputs" | "manual" | "scheduled";

export type EdgeType = "handoff" | "dependency" | "report" | "gate";

export type DeliveryPolicy = "queue" | "latest" | "debounce";

/**
 * Structured payload envelope for edges.
 */
export interface Envelope {
  kind: "handoff" | "signal";
  fromNodeId: string;
  toNodeId: string;
  payload: {
    message?: string;
    structured?: Record<string, unknown>;
    artifacts?: Array<{ type: string; ref: string }>;
    status?: { ok: boolean; reason?: string };
  };
}

export type ProviderId = string; // e.g. "mock", "codex", "claude", "gemini"
export type RoleId = "investigator" | "planner" | "implementer" | "reviewer";

/**
 * Doc agent roles for DOCS_ITERATION phase (section 7.2).
 */
export type DocAgentRole =
  | "architecture-drafter"
  | "ux-spec-drafter"
  | "harness-integration-drafter"
  | "security-permissions-drafter"
  | "doc-reviewer"
  | "doc-merger";

/**
 * Options for manual turn execution.
 */
export interface ManualTurnOptions {
  /** Optional context to attach (artifacts, files, summaries). */
  attachContext?: string[];
  /** Optional JSON schema for structured output. */
  expectedSchema?: string;
  /** Tool policy override for this turn only. */
  turnPolicy?: TurnPolicy;
  /** Max turns to run (usually 1 for manual). */
  maxTurns?: number;
}

// Interaction mode for chat feature
export type InteractionMode = "autonomous" | "interactive";

// Chat message record
export interface ChatMessageRecord {
  id: string;
  runId: string;
  nodeId?: string; // undefined = run-level message
  role: "user" | "system" | "assistant";
  content: string;
  createdAt: string;
  processed: boolean; // Has this message been sent to the agent?
  interruptedExecution: boolean; // Did this message interrupt execution?
}

export interface RunConfigSnapshot {
  // An intentionally flexible config snapshot persisted with each run.
  [k: string]: unknown;
}

/**
 * Policy configuration for auto-pause triggers.
 * When any of these conditions occur, run automatically switches to INTERACTIVE mode.
 */
export interface AutoPausePolicy {
  /** Pause when approval is requested (tool needs human approval). */
  onApprovalRequested?: boolean;
  /** Pause when verification fails. */
  onVerificationFailed?: boolean;
  /** Pause when agent expresses uncertainty/ambiguity. */
  onAmbiguityDetected?: boolean;
  /** Pause when token/iteration budget is exhausted. */
  onBudgetExhausted?: boolean;
}

/**
 * Run-level policy configuration.
 */
export interface RunPolicy {
  /** Default tool allowlist for this run. */
  allowedTools?: string[];
  /** Auto-pause triggers. */
  autoPauseOn?: AutoPausePolicy;
  /** Default approval mode for tools (vuhlp's approval queue). */
  approvalMode?: "always" | "high_risk_only" | "never";
  /**
   * Skip CLI's built-in permission system.
   * When true: CLI runs tools immediately (--dangerously-skip-permissions)
   * When false: CLI waits for permission, vuhlp forwards approvals via stdin
   * Default: true (skip permissions)
   */
  skipCliPermissions?: boolean;
}

/**
 * Node-level policy (overrides run policy).
 */
export interface NodePolicy {
  /** Override allowed tools for this node. */
  allowedTools?: string[];
  /** Override approval mode for this node. */
  approvalMode?: "always" | "high_risk_only" | "never";
}

/**
 * Turn-level policy (overrides node policy for a single turn).
 */
export interface TurnPolicy {
  /** Tool allowlist for this turn only. */
  allowedTools?: string[];
  /** Max tokens for this turn. */
  maxTokens?: number;
}

export interface RunRecord {
  id: string;
  /** Optional user-defined name for the session. */
  name?: string;
  prompt: string;
  repoPath: string;
  status: RunStatus;
  /** Current phase of the run state machine (section 2.1). */
  phase: RunPhase;
  /** Orchestration mode: AUTO (automated) or INTERACTIVE (manual control). */
  mode: RunMode;
  /** Global business logic mode: PLANNING or IMPLEMENTATION. */
  globalMode?: GlobalMode;
  createdAt: string;
  updatedAt: string;
  iterations: number;
  maxIterations: number;
  config: RunConfigSnapshot;
  /** Run-level policy configuration. */
  policy?: RunPolicy;

  rootOrchestratorNodeId: string;

  nodes: Record<string, NodeRecord>;
  edges: Record<string, EdgeRecord>;
  artifacts: Record<string, ArtifactRecord>;

  /** Task DAG for the PLAN phase - tasks with dependencies. */
  taskDag?: TaskDagRecord;
  /** Acceptance criteria generated during PLAN phase. */
  acceptanceCriteria?: AcceptanceCriterion[];
  /** Docs inventory detected during BOOT phase. */
  docsInventory?: DocsInventory;
  /** Repo facts detected during INVESTIGATE phase. */
  repoFacts?: RepoFacts;

  /** Chat messages history. */
  chatMessages: ChatMessageRecord[];

  /** Whether this run is archived (soft-deleted). */
  archived?: boolean;
  /** Timestamp when the run was archived. */
  archivedAt?: string;
}

/**
 * Task DAG record - represents the task graph created during PLAN phase.
 */
export interface TaskDagRecord {
  summary: string;
  steps: TaskStep[];
}

export interface TaskStep {
  id: string;
  title: string;
  instructions?: string;
  agentHint?: string;
  deps: string[]; // IDs of dependent steps
  status?: "pending" | "running" | "completed" | "failed" | "skipped";
  nodeId?: string; // Reference to the node executing this step
}

/**
 * Acceptance criterion - generated during PLAN phase.
 */
export interface AcceptanceCriterion {
  id: string;
  description: string;
  checkType: "test" | "lint" | "build" | "manual" | "doc_exists" | "custom";
  checkCommand?: string;
  passed?: boolean;
  checkedAt?: string;
}

/**
 * Docs inventory - detected during BOOT phase.
 */
export interface DocsInventory {
  hasOverview: boolean;
  hasArchitecture: boolean;
  hasPlan: boolean;
  hasAcceptance: boolean;
  hasDecisions: boolean;
  files: string[];
  missingRequired: string[];
}

/**
 * Docs iteration plan - created when entering DOCS_ITERATION phase (section 7.2).
 */
export interface DocsIterationPlan {
  missingDocs: string[];
  docAgentTasks: Array<{
    id: string;
    role: DocAgentRole;
    targetDoc: string;
    instructions: string;
    deps: string[];
  }>;
}

/**
 * Doc review result - returned by doc-reviewer agent.
 */
export interface DocReviewResult {
  approved: boolean;
  contradictions: Array<{ doc: string; issue: string }>;
  suggestions: string[];
  overallQuality?: "good" | "needs_work" | "poor";
}

/**
 * Repo facts - detected during INVESTIGATE phase.
 */
export interface RepoFacts {
  language: string;
  languages?: string[];
  entrypoints?: string[];
  testCommands?: string[];
  buildCommands?: string[];
  lintCommands?: string[];
  hasTests: boolean;
  hasDocs: boolean;
  isEmptyRepo: boolean;
  isGitRepo: boolean;
  hasOnlyDocs?: boolean;
  hasCode?: boolean;
  gitBranch?: string;
  packageManager?: string;
}

export interface NodeRecord {
  id: string;
  runId: string;
  parentNodeId?: string; // for nested orchestrators
  taskId?: string; // Link to Task DAG step ID
  type: NodeType;

  // JoinGate configuration
  joinPolicy?: {
    type: "all" | "any" | "wait_for";
    requiredCount?: number; // for quorum/wait_for
  };

  // Router configuration
  routerRules?: Array<{
    targetNodeId: string;
    condition: "always" | "on_success" | "on_failure" | "on_artifact";
    conditionArg?: string; // e.g. artifact kind
  }>;

  label: string;
  role?: RoleId;
  providerId?: ProviderId;

  status: NodeStatus;
  /** Node-level control: AUTO (follow run mode) or MANUAL (always require manual trigger). */
  control?: NodeControl;
  /** Node-level policy (overrides run policy). */
  policy?: NodePolicy;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  // Provider session continuity
  /** Provider-specific session ID for resuming conversations. */
  providerSessionId?: string;
  /** Additional session metadata from provider. */
  providerSessionMeta?: Record<string, unknown>;
  /** ID of the last turn executed on this node. */
  lastTurnId?: string;
  /** Number of turns executed on this node. */
  turnCount?: number;

  // Inputs and outputs are intentionally untyped in v0.
  input?: unknown;
  output?: unknown;

  // Human-readable summary.
  summary?: string;
  triggerMode?: TriggerMode;
  stallCount?: number;
  lastFailureSignature?: string;

  workspacePath?: string;
  error?: {
    message: string;
    stack?: string;
  };
}

export interface EdgeRecord {
  id: string;
  runId: string;
  from: string;
  to: string;
  type: EdgeType;
  label?: string;
  deliveryPolicy?: DeliveryPolicy;
  pendingEnvelopes?: Envelope[];
  createdAt: string;
}

export type ArtifactKind = "log" | "diff" | "json" | "text" | "report" | "binary" | "user_feedback";

export interface ArtifactRecord {
  id: string;
  runId: string;
  nodeId: string;
  kind: ArtifactKind;
  name: string;
  mimeType: string;
  path: string; // absolute path on disk
  createdAt: string;
  meta?: Record<string, unknown>;
}

export type VuhlpEventType =
  | "run.created"
  | "run.started"
  | "run.updated"
  | "run.completed"
  | "run.failed"
  | "run.stopped"
  | "run.paused"
  | "run.resumed"
  | "run.mode.changed"
  | "run.phase.changed"
  | "node.created"
  | "node.started"
  | "node.progress"
  | "node.completed"
  | "node.failed"
  | "node.deleted"
  | "node.control.changed"
  | "edge.created"
  | "edge.deleted"
  | "artifact.created"
  | "verification.completed"
  // Message events (custom interface mode)
  | "message.user"
  | "message.assistant.delta"
  | "message.assistant.final"
  | "message.reasoning"
  // Tool events
  | "tool.proposed"
  | "tool.started"
  | "tool.completed"
  // Console events
  | "console.chunk"
  // Approval events
  | "approval.requested"
  | "approval.resolved"
  // Handoff events
  | "handoff.sent"
  | "handoff.reported"
  // Chat events
  | "chat.message.sent"
  | "chat.message.queued"
  | "interaction.mode.changed"
  // Turn events (manual control)
  | "turn.started"
  | "turn.completed"
  // Prompt queue events
  | "prompt.queued"
  | "prompt.sent"
  | "prompt.cancelled";

export interface VuhlpEventBase {
  id: string;
  runId: string;
  ts: string;
  type: VuhlpEventType;
}

export interface RunEvent extends VuhlpEventBase {
  type:
  | "run.created"
  | "run.started"
  | "run.updated"
  | "run.completed"
  | "run.failed"
  | "run.stopped"
  | "run.paused"
  | "run.resumed";
  run: Partial<RunRecord> & { id: string };
}

export interface NodeEvent extends VuhlpEventBase {
  type:
  | "node.created"
  | "node.started"
  | "node.progress"
  | "node.completed"
  | "node.failed";
  nodeId: string;
  patch?: Partial<NodeRecord>;
  message?: string;
  raw?: unknown;
}

export interface NodeDeletedEvent extends VuhlpEventBase {
  type: "node.deleted";
  nodeId: string;
}

export interface EdgeEvent extends VuhlpEventBase {
  type: "edge.created";
  edge: EdgeRecord;
}

export interface EdgeDeletedEvent extends VuhlpEventBase {
  type: "edge.deleted";
  edgeId: string;
}

export interface ArtifactEvent extends VuhlpEventBase {
  type: "artifact.created";
  artifact: ArtifactRecord;
}

export interface VerificationCompletedEvent extends VuhlpEventBase {
  type: "verification.completed";
  nodeId: string;
  report: {
    ok: boolean;
    commands: Array<{
      command: string;
      ok: boolean;
      code: number | null;
      durationMs: number;
      logArtifactId?: string;
    }>;
    docsCheck?: {
      ok: boolean;
      missing: string[];
    };
  };
}

// Message events for custom interface mode
export interface MessageUserEvent extends VuhlpEventBase {
  type: "message.user";
  nodeId: string;
  content: string;
}

export interface MessageAssistantDeltaEvent extends VuhlpEventBase {
  type: "message.assistant.delta";
  nodeId: string;
  delta: string;
  index?: number;
}

export interface MessageAssistantFinalEvent extends VuhlpEventBase {
  type: "message.assistant.final";
  nodeId: string;
  content: string;
  tokenCount?: number;
}

export interface MessageReasoningEvent extends VuhlpEventBase {
  type: "message.reasoning";
  nodeId: string;
  content: string;
}

// Tool events
export type ToolRiskLevel = "low" | "medium" | "high";

export interface ToolProposal {
  id: string;
  name: string;
  args: Record<string, unknown>;
  riskLevel?: ToolRiskLevel;
}

export interface ToolProposedEvent extends VuhlpEventBase {
  type: "tool.proposed";
  nodeId: string;
  tool: ToolProposal;
}

export interface ToolStartedEvent extends VuhlpEventBase {
  type: "tool.started";
  nodeId: string;
  toolId: string;
}

export interface ToolCompletedEvent extends VuhlpEventBase {
  type: "tool.completed";
  nodeId: string;
  toolId: string;
  result?: unknown;
  error?: { message: string; stack?: string };
  durationMs?: number;
}

// Console events
export type ConsoleStream = "stdout" | "stderr";

export interface ConsoleChunkEvent extends VuhlpEventBase {
  type: "console.chunk";
  nodeId: string;
  stream: ConsoleStream;
  data: string;
  timestamp: string;
}

// Approval events
export type ApprovalStatus = "pending" | "approved" | "denied" | "modified" | "timeout";

export interface ApprovalRequestedEvent extends VuhlpEventBase {
  type: "approval.requested";
  nodeId: string;
  approvalId: string;
  tool: ToolProposal;
  context?: string;
  timeoutMs?: number;
}

export interface ApprovalResolution {
  status: ApprovalStatus;
  modifiedArgs?: Record<string, unknown>;
  feedback?: string;
  resolvedBy?: string;
}

export interface ApprovalResolvedEvent extends VuhlpEventBase {
  type: "approval.resolved";
  nodeId: string;
  approvalId: string;
  resolution: ApprovalResolution;
}

// Handoff events for graph animations
export interface HandoffSentEvent extends VuhlpEventBase {
  type: "handoff.sent";
  fromNodeId: string;
  toNodeId: string;
  edgeId: string;
  payload?: {
    promptPreview?: string;
    contextSources?: string[];
  };
}

export interface HandoffReportedEvent extends VuhlpEventBase {
  type: "handoff.reported";
  fromNodeId: string;
  toNodeId: string;
  edgeId: string;
  payload?: {
    summaryPreview?: string;
    artifactCount?: number;
  };
}

// Chat events
export interface ChatMessageSentEvent extends VuhlpEventBase {
  type: "chat.message.sent";
  nodeId?: string;
  message: ChatMessageRecord;
  interrupted: boolean;
}

export interface ChatMessageQueuedEvent extends VuhlpEventBase {
  type: "chat.message.queued";
  nodeId?: string;
  message: ChatMessageRecord;
}

export interface InteractionModeChangedEvent extends VuhlpEventBase {
  type: "interaction.mode.changed";
  nodeId?: string;
  mode: InteractionMode;
  previousMode: InteractionMode;
}

// Run mode events (AUTO/INTERACTIVE orchestration control)
export interface RunModeChangedEvent extends VuhlpEventBase {
  type: "run.mode.changed";
  mode: RunMode;
  previousMode: RunMode;
  /** Reason for the mode change (e.g., "user_request", "auto_pause_policy"). */
  reason?: string;
  /** Number of turns still running when mode changed (for UI feedback). */
  turnsInProgress?: number;
}

// Run phase events (state machine phase transitions)
export interface RunPhaseChangedEvent extends VuhlpEventBase {
  type: "run.phase.changed";
  phase: RunPhase;
  previousPhase: RunPhase;
  /** Reason for the phase transition. */
  reason?: string;
}

// Node control events
export interface NodeControlChangedEvent extends VuhlpEventBase {
  type: "node.control.changed";
  nodeId: string;
  control: NodeControl;
  previousControl: NodeControl;
}

// Turn events for manual control
export interface TurnStartedEvent extends VuhlpEventBase {
  type: "turn.started";
  nodeId: string;
  turnId: string;
  turnNumber: number;
  isManual: boolean;
  prompt?: string;
}

export interface TurnCompletedEvent extends VuhlpEventBase {
  type: "turn.completed";
  nodeId: string;
  turnId: string;
  turnNumber: number;
  isManual: boolean;
  result?: {
    content?: string;
    tokenCount?: number;
    durationMs?: number;
  };
  error?: { message: string; stack?: string };
}

// Session record for provider session continuity
export interface SessionRecord {
  nodeId: string;
  runId: string;
  providerId: string;
  providerSessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

/**
 * Pending prompt - represents a prompt waiting to be sent (section 3.4).
 * Used in the Prompt Queue panel.
 */
export interface PendingPrompt {
  id: string;
  runId: string;
  targetNodeId?: string;
  source: "orchestrator" | "user";
  content: string;
  contextPack?: ContextPack;
  createdAt: string;
  status: "pending" | "sent" | "cancelled";
}

// Prompt queue events
export interface PromptQueuedEvent extends VuhlpEventBase {
  type: "prompt.queued";
  prompt: PendingPrompt;
}

export interface PromptSentEvent extends VuhlpEventBase {
  type: "prompt.sent";
  promptId: string;
  nodeId?: string;
}

export interface PromptCancelledEvent extends VuhlpEventBase {
  type: "prompt.cancelled";
  promptId: string;
  reason?: string;
}

export type VuhlpEvent =
  | RunEvent
  | NodeEvent
  | NodeDeletedEvent
  | EdgeEvent
  | EdgeDeletedEvent
  | ArtifactEvent
  | VerificationCompletedEvent
  | MessageUserEvent
  | MessageAssistantDeltaEvent
  | MessageAssistantFinalEvent
  | MessageReasoningEvent
  | ToolProposedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ConsoleChunkEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | HandoffSentEvent
  | HandoffReportedEvent
  | ChatMessageSentEvent
  | ChatMessageQueuedEvent
  | InteractionModeChangedEvent
  | RunModeChangedEvent
  | RunPhaseChangedEvent
  | NodeControlChangedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | PromptQueuedEvent
  | PromptSentEvent
  | PromptCancelledEvent;

/**
 * Context pack - curated working set per node (section 5.3.3).
 * Minimal, relevant context per node prompt.
 */
export interface ContextPack {
  taskId: string;
  goal: string;
  docsSourceOfTruth?: Array<{ path: string; anchors?: string[] }>;
  repoFacts?: Partial<RepoFacts>;
  relevantFiles?: Array<{ path: string; summary?: string }>;
  priorResults?: Array<{ from: string; artifact?: string; summary?: string }>;
  constraints?: {
    noNewDependencies?: boolean;
    mustUpdateDocsOnBehaviorChange?: boolean;
    maxTokens?: number;
    allowedTools?: string[];
  };
  outputSchema?: string;
}

/**
 * Orchestrator action - JSON action output from orchestrator (section 5.2).
 * Machine-readable scheduling decisions.
 */
export type OrchestratorActionType =
  | "spawn_node"
  | "continue_node"
  | "pause_node"
  | "verify"
  | "doc_update"
  | "transition_phase"
  | "complete_run"
  | "fail_run";

export interface OrchestratorAction {
  type: OrchestratorActionType;
  nodeId?: string;
  providerId?: string;
  role?: RoleId;
  prompt?: string;
  contextPack?: ContextPack;
  reason?: string;
  targetPhase?: RunPhase;
}

/**
 * Orchestrator tick input - synthetic input for AUTO mode (section 5.2.3).
 */
export interface OrchestratorTickInput {
  mode: RunMode;
  delta: {
    completedNodes?: Array<{ nodeId: string; artifactId?: string }>;
    failedTests?: number;
    pendingDocs?: string[];
  };
  planStatus: {
    totalTasks: number;
    doneTasks: number;
    blockedTasks: number;
    readyTasks: number;
  };
}
