import { EventBus } from "./eventBus.js";
import { RunStore } from "./store.js";
import { OrchestratorTickInput, RunRecord } from "./types.js";

/**
 * TickEmitter - Manages synthetic tick inputs for AUTO mode (section 5.2.3).
 *
 * In AUTO mode, the orchestrator receives periodic "tick" inputs to wake it
 * and continue scheduling. This replaces the need for continuous polling and
 * provides a structured update mechanism.
 */
export class TickEmitter {
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private store: RunStore;
  private bus: EventBus;
  private onTick: (runId: string, tick: OrchestratorTickInput) => Promise<void>;

  // Track which nodes have been processed in the last tick
  private processedNodes: Map<string, Set<string>> = new Map();

  constructor(params: {
    store: RunStore;
    bus: EventBus;
    onTick: (runId: string, tick: OrchestratorTickInput) => Promise<void>;
  }) {
    this.store = params.store;
    this.bus = params.bus;
    this.onTick = params.onTick;
  }

  /**
   * Start emitting ticks for a run.
   */
  startTicking(runId: string, intervalMs: number = 1000): void {
    if (this.intervals.has(runId)) return;

    // Initialize processed nodes set
    this.processedNodes.set(runId, new Set());

    const interval = setInterval(async () => {
      const run = this.store.getRun(runId);
      if (!run) {
        this.stopTicking(runId);
        return;
      }

      // Stop ticking if run is not running or not in AUTO mode
      if (run.status !== "running" || run.mode !== "AUTO") {
        this.stopTicking(runId);
        return;
      }

      try {
        const tick = this.buildTickInput(run);
        await this.onTick(runId, tick);
      } catch (e) {
        // Log error but continue ticking
        console.error(`Tick error for run ${runId}:`, e);
      }
    }, intervalMs);

    this.intervals.set(runId, interval);
  }

  /**
   * Stop emitting ticks for a run.
   */
  stopTicking(runId: string): void {
    const interval = this.intervals.get(runId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(runId);
    }
    this.processedNodes.delete(runId);
  }

  /**
   * Check if ticking is active for a run.
   */
  isTickingActive(runId: string): boolean {
    return this.intervals.has(runId);
  }

  /**
   * Build a tick input from current run state.
   */
  private buildTickInput(run: RunRecord): OrchestratorTickInput {
    const nodes = Object.values(run.nodes);
    const processedSet = this.processedNodes.get(run.id) ?? new Set();

    // Find nodes completed since last tick
    const completedSinceLast: Array<{ nodeId: string; artifactId?: string }> = [];
    for (const node of nodes) {
      if (node.status === "completed" && !processedSet.has(node.id)) {
        // Find the most recent artifact for this node
        const nodeArtifacts = Object.values(run.artifacts)
          .filter((a) => a.nodeId === node.id)
          .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));

        completedSinceLast.push({
          nodeId: node.id,
          artifactId: nodeArtifacts[0]?.id,
        });
        processedSet.add(node.id);
      }
    }

    // Count failed tests from verification nodes
    let failedTests = 0;
    for (const node of nodes) {
      if (node.type === "verification" && node.status === "failed") {
        failedTests++;
      }
    }

    // Get pending docs
    const pendingDocs = run.docsInventory?.missingRequired ?? [];

    // Calculate plan status
    const taskDag = run.taskDag;
    const totalTasks = taskDag?.steps.length ?? 0;
    const doneTasks = nodes.filter((n) => n.status === "completed" && n.type === "task").length;
    const blockedTasks = nodes.filter((n) =>
      n.status === "blocked_dependency" ||
      n.status === "blocked_approval" ||
      n.status === "blocked_manual_input"
    ).length;
    const readyTasks = nodes.filter((n) => n.status === "queued").length;

    return {
      mode: run.mode,
      delta: {
        completedNodes: completedSinceLast.length > 0 ? completedSinceLast : undefined,
        failedTests: failedTests > 0 ? failedTests : undefined,
        pendingDocs: pendingDocs.length > 0 ? pendingDocs : undefined,
      },
      planStatus: {
        totalTasks,
        doneTasks,
        blockedTasks,
        readyTasks,
      },
    };
  }

  /**
   * Force an immediate tick (useful for testing or manual triggers).
   */
  async forceTick(runId: string): Promise<OrchestratorTickInput | null> {
    const run = this.store.getRun(runId);
    if (!run) return null;

    const tick = this.buildTickInput(run);
    await this.onTick(runId, tick);
    return tick;
  }

  /**
   * Reset the processed nodes set (useful when resuming a run).
   */
  resetProcessedNodes(runId: string): void {
    this.processedNodes.set(runId, new Set());
  }

  /**
   * Stop all active ticks (cleanup on shutdown).
   */
  stopAll(): void {
    for (const runId of this.intervals.keys()) {
      this.stopTicking(runId);
    }
  }
}
