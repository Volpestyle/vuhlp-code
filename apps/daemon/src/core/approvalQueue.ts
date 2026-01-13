import { randomUUID } from "node:crypto";
import { ToolProposal, ApprovalStatus, ApprovalResolution } from "./types.js";
import { nowIso } from "./time.js";
import { EventBus } from "./eventBus.js";

/**
 * ApprovalRequest represents a pending tool execution that requires user approval.
 */
export interface ApprovalRequest {
  id: string;
  runId: string;
  nodeId: string;
  tool: ToolProposal;
  context?: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  resolution?: ApprovalResolution;
  timeoutMs?: number;
  timeoutAt?: string;
}

export interface ApprovalQueueConfig {
  /** Default timeout for approvals in milliseconds. 0 means no timeout. */
  defaultTimeoutMs?: number;
  /** Auto-deny on timeout. If false, approval stays pending. */
  autoDenyOnTimeout?: boolean;
}

/**
 * ApprovalQueue manages pending approval requests across all runs and nodes.
 *
 * It provides:
 * - A central queue for all pending approvals
 * - Timeout handling with auto-deny option
 * - Event emission for approval lifecycle
 * - Blocking/waiting for approval resolution
 */
export class ApprovalQueue {
  private bus: EventBus;
  private cfg: ApprovalQueueConfig;
  private requests: Map<string, ApprovalRequest> = new Map();
  private waiters: Map<string, {
    resolve: (resolution: ApprovalResolution) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private timeoutHandles: Map<string, NodeJS.Timeout> = new Map();

  constructor(bus: EventBus, cfg: ApprovalQueueConfig = {}) {
    this.bus = bus;
    this.cfg = cfg;
  }

  /**
   * Request approval for a tool execution.
   * Returns a promise that resolves when the approval is resolved.
   */
  async requestApproval(params: {
    runId: string;
    nodeId: string;
    tool: ToolProposal;
    context?: string;
    timeoutMs?: number;
  }): Promise<ApprovalResolution> {
    const id = randomUUID();
    const timeoutMs = params.timeoutMs ?? this.cfg.defaultTimeoutMs ?? 0;
    const now = nowIso();

    const request: ApprovalRequest = {
      id,
      runId: params.runId,
      nodeId: params.nodeId,
      tool: params.tool,
      context: params.context,
      status: "pending",
      createdAt: now,
      timeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
      timeoutAt: timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : undefined,
    };

    this.requests.set(id, request);

    // Emit approval requested event
    this.bus.emitApprovalRequested(
      params.runId,
      params.nodeId,
      id,
      params.tool,
      params.context,
      timeoutMs > 0 ? timeoutMs : undefined
    );

    // Set up timeout if configured
    if (timeoutMs > 0) {
      const handle = setTimeout(() => {
        this.handleTimeout(id);
      }, timeoutMs);
      this.timeoutHandles.set(id, handle);
    }

    // Create and return a promise that waits for resolution
    return new Promise<ApprovalResolution>((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
    });
  }

  /**
   * Resolve an approval request.
   */
  resolve(approvalId: string, resolution: ApprovalResolution): boolean {
    const request = this.requests.get(approvalId);
    if (!request || request.status !== "pending") {
      return false;
    }

    // Clear timeout if set
    const timeout = this.timeoutHandles.get(approvalId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeoutHandles.delete(approvalId);
    }

    // Update request
    request.status = resolution.status;
    request.resolution = resolution;
    request.resolvedAt = nowIso();

    // Emit approval resolved event
    this.bus.emitApprovalResolved(
      request.runId,
      request.nodeId,
      approvalId,
      resolution
    );

    // Resolve the waiter
    const waiter = this.waiters.get(approvalId);
    if (waiter) {
      waiter.resolve(resolution);
      this.waiters.delete(approvalId);
    }

    return true;
  }

  /**
   * Approve a request.
   */
  approve(approvalId: string, feedback?: string): boolean {
    return this.resolve(approvalId, {
      status: "approved",
      feedback,
    });
  }

  /**
   * Deny a request.
   */
  deny(approvalId: string, feedback?: string): boolean {
    return this.resolve(approvalId, {
      status: "denied",
      feedback,
    });
  }

  /**
   * Modify a request (approve with modified args).
   */
  modify(approvalId: string, modifiedArgs: Record<string, unknown>, feedback?: string): boolean {
    return this.resolve(approvalId, {
      status: "modified",
      modifiedArgs,
      feedback,
    });
  }

  /**
   * Get a specific approval request.
   */
  get(approvalId: string): ApprovalRequest | undefined {
    return this.requests.get(approvalId);
  }

  /**
   * Get all pending approvals.
   */
  getPending(): ApprovalRequest[] {
    return Array.from(this.requests.values()).filter((r) => r.status === "pending");
  }

  /**
   * Get all pending approvals for a specific run.
   */
  getPendingForRun(runId: string): ApprovalRequest[] {
    return this.getPending().filter((r) => r.runId === runId);
  }

  /**
   * Get all pending approvals for a specific node.
   */
  getPendingForNode(nodeId: string): ApprovalRequest[] {
    return this.getPending().filter((r) => r.nodeId === nodeId);
  }

  /**
   * Get all approvals (including resolved).
   */
  getAll(): ApprovalRequest[] {
    return Array.from(this.requests.values());
  }

  /**
   * Get all approvals for a specific run.
   */
  getAllForRun(runId: string): ApprovalRequest[] {
    return this.getAll().filter((r) => r.runId === runId);
  }

  /**
   * Cancel all pending approvals for a run (e.g., when run is stopped).
   */
  cancelForRun(runId: string): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.runId === runId && request.status === "pending") {
        this.resolve(request.id, {
          status: "denied",
          feedback: "Run was stopped",
        });
        count++;
      }
    }
    return count;
  }

  /**
   * Cancel all pending approvals for a node.
   */
  cancelForNode(nodeId: string): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.nodeId === nodeId && request.status === "pending") {
        this.resolve(request.id, {
          status: "denied",
          feedback: "Node was stopped",
        });
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all resolved approvals (keep pending).
   */
  clearResolved(): number {
    let count = 0;
    for (const [id, request] of this.requests) {
      if (request.status !== "pending") {
        this.requests.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Handle timeout for an approval.
   */
  private handleTimeout(approvalId: string): void {
    this.timeoutHandles.delete(approvalId);

    const request = this.requests.get(approvalId);
    if (!request || request.status !== "pending") {
      return;
    }

    if (this.cfg.autoDenyOnTimeout !== false) {
      this.resolve(approvalId, {
        status: "timeout",
        feedback: `Approval timed out after ${request.timeoutMs}ms`,
      });
    }
  }
}
