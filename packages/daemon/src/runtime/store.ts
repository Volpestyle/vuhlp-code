import type {
  ApprovalRequest,
  Artifact,
  EdgeState,
  Envelope,
  NodeConfig,
  NodeState,
  RunState,
  UserMessageRecord,
  UUID
} from "@vuhlp/contracts";
import { EventLog } from "./event-log.js";

export interface NodeRuntime {
  inbox: Envelope[];
  queuedMessages: UserMessageRecord[];
  pendingTurn: boolean;
  cancelRequested: boolean;
  lastOutputHash?: string;
  lastDiffHash?: string;
  lastVerificationFailure?: string;
  summaryHistory: string[];
  outputRepeatCount: number;
  diffRepeatCount: number;
  verificationRepeatCount: number;
}

export interface NodeRecord {
  state: NodeState;
  config: NodeConfig;
  runtime: NodeRuntime;
}

export interface RunRecord {
  state: RunState;
  nodes: Map<UUID, NodeRecord>;
  edges: Map<UUID, EdgeState>;
  artifacts: Map<UUID, Artifact>;
  approvals: Map<UUID, ApprovalRequest>;
  eventLog: EventLog;
}

export class RunStore {
  private runs = new Map<UUID, RunRecord>();
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  createRun(runState: RunState): RunRecord {
    const record: RunRecord = {
      state: runState,
      nodes: new Map(),
      edges: new Map(),
      artifacts: new Map(),
      approvals: new Map(),
      eventLog: new EventLog(this.dataDir, runState.id)
    };
    this.runs.set(runState.id, record);
    return record;
  }

  getRun(runId: UUID): RunRecord | undefined {
    return this.runs.get(runId);
  }

  listRuns(): RunState[] {
    return Array.from(this.runs.values()).map((record) => record.state);
  }

  deleteRun(runId: UUID): RunRecord | undefined {
    const record = this.runs.get(runId);
    if (!record) {
      return undefined;
    }
    this.runs.delete(runId);
    return record;
  }

  addNode(runId: UUID, node: NodeState, config: NodeConfig): NodeRecord {
    const record = this.requireRun(runId);
    const nodeRecord: NodeRecord = {
      state: node,
      config,
      runtime: {
        inbox: [],
        queuedMessages: [],
        pendingTurn: false,
        cancelRequested: false,
        summaryHistory: [],
        outputRepeatCount: 0,
        diffRepeatCount: 0,
        verificationRepeatCount: 0
      }
    };
    record.nodes.set(node.id, nodeRecord);
    record.state.nodes[node.id] = node;
    return nodeRecord;
  }

  updateNode(runId: UUID, nodeId: UUID, patch: Partial<NodeState>): NodeState {
    const record = this.requireRun(runId);
    const nodeRecord = this.requireNode(record, nodeId);
    nodeRecord.state = { ...nodeRecord.state, ...patch };
    record.state.nodes[nodeId] = nodeRecord.state;
    return nodeRecord.state;
  }

  updateNodeConfig(runId: UUID, nodeId: UUID, patch: Partial<NodeConfig>): NodeConfig {
    const record = this.requireRun(runId);
    const nodeRecord = this.requireNode(record, nodeId);
    nodeRecord.config = { ...nodeRecord.config, ...patch };
    return nodeRecord.config;
  }

  addEdge(runId: UUID, edge: EdgeState): EdgeState {
    const record = this.requireRun(runId);
    record.edges.set(edge.id, edge);
    record.state.edges[edge.id] = edge;
    return edge;
  }

  deleteEdge(runId: UUID, edgeId: UUID): void {
    const record = this.requireRun(runId);
    record.edges.delete(edgeId);
    delete record.state.edges[edgeId];
  }

  addArtifact(runId: UUID, artifact: Artifact): void {
    const record = this.requireRun(runId);
    record.artifacts.set(artifact.id, artifact);
    record.state.artifacts[artifact.id] = artifact;
  }

  addApproval(runId: UUID, approval: ApprovalRequest): void {
    const record = this.requireRun(runId);
    record.approvals.set(approval.approvalId, approval);
  }

  resolveApproval(runId: UUID, approvalId: UUID): ApprovalRequest | undefined {
    const record = this.requireRun(runId);
    const approval = record.approvals.get(approvalId);
    if (approval) {
      record.approvals.delete(approvalId);
    }
    return approval;
  }

  listApprovals(): Array<{ runId: UUID; approval: ApprovalRequest }> {
    const approvals: Array<{ runId: UUID; approval: ApprovalRequest }> = [];
    for (const record of this.runs.values()) {
      for (const approval of record.approvals.values()) {
        approvals.push({ runId: record.state.id, approval });
      }
    }
    return approvals;
  }

  resolveApprovalById(approvalId: UUID): { runId: UUID; approval: ApprovalRequest } | undefined {
    for (const record of this.runs.values()) {
      const approval = record.approvals.get(approvalId);
      if (approval) {
        record.approvals.delete(approvalId);
        return { runId: record.state.id, approval };
      }
    }
    return undefined;
  }

  enqueueEnvelope(runId: UUID, nodeId: UUID, envelope: Envelope): void {
    const record = this.requireRun(runId);
    const nodeRecord = this.requireNode(record, nodeId);
    nodeRecord.runtime.inbox.push(envelope);
    nodeRecord.state.inboxCount = nodeRecord.runtime.inbox.length;
    record.state.nodes[nodeId] = nodeRecord.state;
  }

  enqueueMessage(runId: UUID, nodeId: UUID, message: UserMessageRecord, interrupt = false): void {
    const record = this.requireRun(runId);
    const nodeRecord = this.requireNode(record, nodeId);
    if (interrupt) {
      nodeRecord.runtime.queuedMessages.unshift(message);
    } else {
      nodeRecord.runtime.queuedMessages.push(message);
    }
    nodeRecord.state.inboxCount = nodeRecord.runtime.inbox.length + nodeRecord.runtime.queuedMessages.length;
    record.state.nodes[nodeId] = nodeRecord.state;
  }

  consumeInbox(nodeRecord: NodeRecord): { envelopes: Envelope[]; messages: UserMessageRecord[] } {
    const envelopes = nodeRecord.runtime.inbox;
    const messages = nodeRecord.runtime.queuedMessages;
    nodeRecord.runtime.inbox = [];
    nodeRecord.runtime.queuedMessages = [];
    nodeRecord.state.inboxCount = 0;
    return { envelopes, messages };
  }

  private requireRun(runId: UUID): RunRecord {
    const record = this.runs.get(runId);
    if (!record) {
      throw new Error(`Run ${runId} not found`);
    }
    return record;
  }

  private requireNode(record: RunRecord, nodeId: UUID): NodeRecord {
    const nodeRecord = record.nodes.get(nodeId);
    if (!nodeRecord) {
      throw new Error(`Node ${nodeId} not found`);
    }
    return nodeRecord;
  }
}
