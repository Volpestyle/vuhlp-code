import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApprovalQueue, ApprovalQueueConfig, ApprovalRequest } from "../approvalQueue.js";
import { EventBus } from "../eventBus.js";
import { ToolProposal } from "../types.js";

// Mock EventBus
const createMockEventBus = () => ({
  emitApprovalRequested: vi.fn(),
  emitApprovalResolved: vi.fn(),
});

describe("ApprovalQueue", () => {
  let queue: ApprovalQueue;
  let mockBus: ReturnType<typeof createMockEventBus>;

  const testTool: ToolProposal = {
    id: "tool-1",
    name: "Bash",
    args: { command: "ls -la" },
    riskLevel: "medium",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockBus = createMockEventBus();
    queue = new ApprovalQueue(mockBus as unknown as EventBus);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("requestApproval", () => {
    it("creates a pending approval request", async () => {
      const promise = queue.requestApproval({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
        context: "Test context",
      });

      const pending = queue.getPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
        context: "Test context",
        status: "pending",
      });

      // Don't await since it blocks until resolved
      expect(promise).toBeInstanceOf(Promise);
    });

    it("emits approval.requested event", async () => {
      queue.requestApproval({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
      });

      expect(mockBus.emitApprovalRequested).toHaveBeenCalledWith(
        "run-1",
        "node-1",
        expect.any(String),
        testTool,
        undefined,
        undefined
      );
    });

    it("sets timeout when configured", async () => {
      queue.requestApproval({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
        timeoutMs: 5000,
      });

      const pending = queue.getPending();
      expect(pending[0].timeoutMs).toBe(5000);
      expect(pending[0].timeoutAt).toBeDefined();
    });
  });

  describe("approve", () => {
    it("resolves the approval with approved status", async () => {
      const promise = queue.requestApproval({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
      });

      const pending = queue.getPending();
      const id = pending[0].id;

      const result = queue.approve(id, "Looks good");
      expect(result).toBe(true);

      const resolution = await promise;
      expect(resolution).toMatchObject({
        status: "approved",
        feedback: "Looks good",
      });
    });

    it("emits approval.resolved event", async () => {
      queue.requestApproval({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
      });

      const id = queue.getPending()[0].id;
      queue.approve(id);

      expect(mockBus.emitApprovalResolved).toHaveBeenCalledWith(
        "run-1",
        "node-1",
        id,
        expect.objectContaining({ status: "approved" })
      );
    });

    it("returns false for unknown approval id", () => {
      expect(queue.approve("unknown-id")).toBe(false);
    });

    it("returns false for already resolved approval", async () => {
      queue.requestApproval({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
      });

      const id = queue.getPending()[0].id;
      queue.approve(id);
      expect(queue.approve(id)).toBe(false);
    });
  });

  describe("deny", () => {
    it("resolves the approval with denied status", async () => {
      const promise = queue.requestApproval({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
      });

      const id = queue.getPending()[0].id;
      queue.deny(id, "Too risky");

      const resolution = await promise;
      expect(resolution).toMatchObject({
        status: "denied",
        feedback: "Too risky",
      });
    });
  });

  describe("modify", () => {
    it("resolves the approval with modified status and args", async () => {
      const promise = queue.requestApproval({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
      });

      const id = queue.getPending()[0].id;
      queue.modify(id, { command: "ls -l" }, "Removed -a flag");

      const resolution = await promise;
      expect(resolution).toMatchObject({
        status: "modified",
        modifiedArgs: { command: "ls -l" },
        feedback: "Removed -a flag",
      });
    });
  });

  describe("timeout handling", () => {
    it("auto-denies on timeout by default", async () => {
      const promise = queue.requestApproval({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
        timeoutMs: 1000,
      });

      vi.advanceTimersByTime(1000);

      const resolution = await promise;
      expect(resolution.status).toBe("timeout");
      expect(resolution.feedback).toContain("timed out");
    });

    it("clears timeout when resolved before expiry", async () => {
      const promise = queue.requestApproval({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
        timeoutMs: 5000,
      });

      const id = queue.getPending()[0].id;
      queue.approve(id);

      vi.advanceTimersByTime(5000);

      const resolution = await promise;
      expect(resolution.status).toBe("approved");
    });

    it("respects autoDenyOnTimeout config", async () => {
      const nonDenyQueue = new ApprovalQueue(mockBus as unknown as EventBus, {
        autoDenyOnTimeout: false,
      });

      nonDenyQueue.requestApproval({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
        timeoutMs: 1000,
      });

      vi.advanceTimersByTime(1000);

      // Should still be pending
      expect(nonDenyQueue.getPending()).toHaveLength(1);
    });
  });

  describe("query methods", () => {
    it("getPending returns only pending approvals", async () => {
      queue.requestApproval({ runId: "run-1", nodeId: "node-1", tool: testTool });
      queue.requestApproval({ runId: "run-1", nodeId: "node-2", tool: testTool });

      const id = queue.getPending()[0].id;
      queue.approve(id);

      expect(queue.getPending()).toHaveLength(1);
    });

    it("getPendingForRun filters by runId", async () => {
      queue.requestApproval({ runId: "run-1", nodeId: "node-1", tool: testTool });
      queue.requestApproval({ runId: "run-2", nodeId: "node-2", tool: testTool });

      expect(queue.getPendingForRun("run-1")).toHaveLength(1);
      expect(queue.getPendingForRun("run-2")).toHaveLength(1);
      expect(queue.getPendingForRun("run-3")).toHaveLength(0);
    });

    it("getPendingForNode filters by nodeId", async () => {
      queue.requestApproval({ runId: "run-1", nodeId: "node-1", tool: testTool });
      queue.requestApproval({ runId: "run-1", nodeId: "node-2", tool: testTool });

      expect(queue.getPendingForNode("node-1")).toHaveLength(1);
      expect(queue.getPendingForNode("node-2")).toHaveLength(1);
      expect(queue.getPendingForNode("node-3")).toHaveLength(0);
    });

    it("getAll returns all approvals including resolved", async () => {
      queue.requestApproval({ runId: "run-1", nodeId: "node-1", tool: testTool });
      queue.requestApproval({ runId: "run-1", nodeId: "node-2", tool: testTool });

      const id = queue.getPending()[0].id;
      queue.approve(id);

      expect(queue.getAll()).toHaveLength(2);
    });

    it("get returns specific approval by id", async () => {
      queue.requestApproval({ runId: "run-1", nodeId: "node-1", tool: testTool });

      const pending = queue.getPending()[0];
      const retrieved = queue.get(pending.id);

      expect(retrieved).toEqual(pending);
      expect(queue.get("unknown")).toBeUndefined();
    });
  });

  describe("cancelForRun", () => {
    it("denies all pending approvals for a run", async () => {
      const p1 = queue.requestApproval({ runId: "run-1", nodeId: "node-1", tool: testTool });
      const p2 = queue.requestApproval({ runId: "run-1", nodeId: "node-2", tool: testTool });
      queue.requestApproval({ runId: "run-2", nodeId: "node-3", tool: testTool });

      const count = queue.cancelForRun("run-1");
      expect(count).toBe(2);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.status).toBe("denied");
      expect(r2.status).toBe("denied");
      expect(r1.feedback).toContain("stopped");

      expect(queue.getPendingForRun("run-1")).toHaveLength(0);
      expect(queue.getPendingForRun("run-2")).toHaveLength(1);
    });
  });

  describe("cancelForNode", () => {
    it("denies all pending approvals for a node", async () => {
      const p1 = queue.requestApproval({ runId: "run-1", nodeId: "node-1", tool: testTool });
      queue.requestApproval({ runId: "run-1", nodeId: "node-2", tool: testTool });

      const count = queue.cancelForNode("node-1");
      expect(count).toBe(1);

      const r1 = await p1;
      expect(r1.status).toBe("denied");
      expect(r1.feedback).toContain("stopped");

      expect(queue.getPendingForNode("node-1")).toHaveLength(0);
      expect(queue.getPendingForNode("node-2")).toHaveLength(1);
    });
  });

  describe("clearResolved", () => {
    it("removes resolved approvals from the queue", async () => {
      queue.requestApproval({ runId: "run-1", nodeId: "node-1", tool: testTool });
      queue.requestApproval({ runId: "run-1", nodeId: "node-2", tool: testTool });

      const id = queue.getPending()[0].id;
      queue.approve(id);

      expect(queue.getAll()).toHaveLength(2);

      const count = queue.clearResolved();
      expect(count).toBe(1);
      expect(queue.getAll()).toHaveLength(1);
      expect(queue.getPending()).toHaveLength(1);
    });
  });

  describe("default timeout config", () => {
    it("uses defaultTimeoutMs from config", async () => {
      const queueWithDefault = new ApprovalQueue(mockBus as unknown as EventBus, {
        defaultTimeoutMs: 3000,
      });

      queueWithDefault.requestApproval({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
      });

      const pending = queueWithDefault.getPending()[0];
      expect(pending.timeoutMs).toBe(3000);
    });

    it("allows per-request timeout to override default", async () => {
      const queueWithDefault = new ApprovalQueue(mockBus as unknown as EventBus, {
        defaultTimeoutMs: 3000,
      });

      queueWithDefault.requestApproval({
        runId: "run-1",
        nodeId: "node-1",
        tool: testTool,
        timeoutMs: 5000,
      });

      const pending = queueWithDefault.getPending()[0];
      expect(pending.timeoutMs).toBe(5000);
    });
  });
});
