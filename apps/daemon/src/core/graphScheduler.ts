import { EventEmitter } from "node:events";
import { Semaphore } from "./scheduler.js";
import { RunStore } from "./store.js";
import { EventBus } from "./eventBus.js";
import { ChatManager } from "./chatManager.js";
import { NodeExecutor } from "./nodeExecutor.js";
import { RunRecord, Envelope } from "./types.js";

interface SchedulerConfig {
    maxConcurrency: number;
}

export class GraphScheduler {
    private semaphore: Semaphore;
    private inFlight = new Set<string>();
    private activeLoops = new Map<string, Promise<void>>();
    private loopControllers = new Map<string, AbortController>();
    private pauseSignals = new Map<string, { resolve: () => void; promise: Promise<void> }>();
    private modeStopFlags = new Map<string, boolean>();

    constructor(
        private store: RunStore,
        private bus: EventBus,
        private chatManager: ChatManager,
        private nodeExecutor: NodeExecutor,
        private config: SchedulerConfig
    ) {
        this.semaphore = new Semaphore(config.maxConcurrency);
    }

    /**
     * Start the scheduler loop for a specific run.
     */
    async start(runId: string): Promise<void> {
        if (this.activeLoops.has(runId)) return;

        const controller = new AbortController();
        this.loopControllers.set(runId, controller);

        // Resume loop if it was paused
        if (this.pauseSignals.has(runId)) {
            const p = this.pauseSignals.get(runId);
            p?.resolve();
            this.pauseSignals.delete(runId);
        }

        const loopPromise = this.runLoop(runId, controller.signal);
        this.activeLoops.set(runId, loopPromise);

        try {
            await loopPromise;
        } finally {
            this.activeLoops.delete(runId);
            this.loopControllers.delete(runId);
            this.pauseSignals.delete(runId);
        }
    }

    stop(runId: string): void {
        const controller = this.loopControllers.get(runId);
        if (controller) {
            controller.abort();
        }
        // resolve pause so loop exits
        const pause = this.pauseSignals.get(runId);
        if (pause) pause.resolve();
    }

    pause(runId: string): boolean {
        if (!this.activeLoops.has(runId)) return false;
        if (this.pauseSignals.has(runId)) return true;

        let resolve: () => void = () => { };
        const promise = new Promise<void>((r) => { resolve = r; });
        this.pauseSignals.set(runId, { resolve, promise });

        // Abort current execution step signals to interrupt ASAP? 
        // We don't have direct access to node-level signals here easily unless we track them.
        // For V0 refactor, let's rely on the loop checking pause state.

        return true;
    }

    resume(runId: string): boolean {
        const pause = this.pauseSignals.get(runId);
        if (!pause) return false;

        pause.resolve();
        this.pauseSignals.delete(runId);
        // If controller was aborted to pause, we might need to reset it?
        // In this model, we don't abort controller to pause, we just wait on promise.

        return true;
    }

    setInteractionMode(runId: string, enabled: boolean): void {
        if (enabled) {
            this.modeStopFlags.set(runId, true);
        } else {
            this.modeStopFlags.delete(runId);
        }
    }

    private async runLoop(runId: string, signal: AbortSignal): Promise<void> {
        const run = this.store.getRun(runId);
        if (!run) return;

        while (!signal.aborted) {
            // 1. Check Pause
            const pause = this.pauseSignals.get(runId);
            if (pause) {
                await pause.promise;
                if (signal.aborted) break;
            }

            // 2. Check Interactive Mode
            // 2. Check Interactive Mode & Wake up nodes with messages
            const isInteractive = run.mode === "INTERACTIVE" || this.modeStopFlags.get(runId);

            // Check for pending chat messages to wake up nodes
            const pendingMessages = this.chatManager.getPendingMessages(runId);
            if (pendingMessages.length > 0) {
                const uniqueNodeIds = new Set(pendingMessages.map(m => m.nodeId).filter(id => id !== undefined) as string[]);
                // Assign orphan messages to root if possible
                const hasOrphanMessages = pendingMessages.some(m => m.nodeId === undefined);
                if (hasOrphanMessages && run.rootOrchestratorNodeId) {
                    uniqueNodeIds.add(run.rootOrchestratorNodeId);
                }

                let wokenCount = 0;
                for (const nodeId of uniqueNodeIds) {
                    const node = run.nodes[nodeId];
                    // If node is idle (completed/failed/skipped/cancelled) or just not running/queued, wake it up
                    // We don't disturb 'running' nodes as they will pick up messages in their current or next tick?
                    // Actually, if it's running, it might arguably be blocked on manual input, but let's ensure it's queued if it's not running.
                    if (node && node.status !== "running" && node.status !== "queued") {
                        node.status = "queued";
                        this.bus.emitNodePatch(runId, nodeId, { status: "queued" }, "node.progress");
                        wokenCount++;
                    }
                }
                if (wokenCount > 0) this.store.persistRun(run);
            }

            if (isInteractive) {
                // In interactive mode, we ONLY proceed if we have pending messages OR if we have explicitly queued nodes 
                // that might have been queued by a previous step (handoffs).
                // But strictly speaking, if we want to "Wait for User", we might only want to run if messages exist?
                // However, avoiding a deadlock is better. If there are ready nodes, we generally want to run them 
                // UNLESS we want to force a pause. 
                // For now, let's UNBLOCK if there are pending messages.
                // If there are NO pending messages, we pause.

                if (pendingMessages.length === 0) {
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }
            }

            // 3. Scan for Ready Nodes
            const readyNodes = this.getReadyNodes(runId);

            for (const nodeId of readyNodes) {
                if (this.inFlight.has(nodeId)) continue;

                this.inFlight.add(nodeId);
                // Fire and forget (managed by inFlight set)
                void (async () => {
                    const release = await this.semaphore.acquire();
                    try {
                        // Consume Inputs -> this makes them "taken"
                        const inputs = this.consumeEnvelopes(runId, nodeId);

                        // Consume Chat Messages
                        const chatContext = this.consumeChatMessages(runId, nodeId);

                        await this.nodeExecutor.executeNode(
                            runId,
                            nodeId,
                            inputs,
                            signal,
                            () => this.store.getRun(runId)?.globalMode ?? "PLANNING",
                            chatContext
                        );

                        // Handle output dispatching here?
                        // Or let NodeExecutor do it? 
                        // Original: Orchestrator did dispatch. 
                        // Let's keep NodeExecutor focused on execution, Scheduler focused on data flow?
                        // Doing dispatch HERE means we need to read the node output from store.
                        const updatedRun = this.store.getRun(runId);
                        const updatedNode = updatedRun?.nodes[nodeId];
                        if (updatedNode?.status === "completed") {
                            this.dispatchOutput(runId, nodeId, updatedNode.output);
                        }

                    } catch (e) {
                        console.error(`Execution failed for ${nodeId}`, e);
                    } finally {
                        release();
                        this.inFlight.delete(nodeId);
                    }
                })();
            }

            // Wait a tick
            await new Promise(r => setTimeout(r, 200));
        }
    }

    private getReadyNodes(runId: string): string[] {
        const run = this.store.getRun(runId);
        if (!run) return [];

        return Object.values(run.nodes)
            .filter(n => n.status === "queued")
            .map(n => n.id);
    }

    private consumeChatMessages(runId: string, nodeId: string): string | undefined {
        const run = this.store.getRun(runId);
        const rootNodeId = run?.rootOrchestratorNodeId;
        const rootNode = rootNodeId ? run?.nodes[rootNodeId] : undefined;
        const rootIsTerminated = rootNode && (rootNode.status === "completed" || rootNode.status === "failed" || rootNode.status === "skipped");
        const isRoot = nodeId === rootNodeId;

        // Orphan Adoption Logic
        let shouldAdoptOrphans = isRoot;
        if (!shouldAdoptOrphans && rootIsTerminated) {
            // If root is dead, the first active node adopts orphans
            const activeNodeIds = Object.keys(run?.nodes ?? {})
                .filter(id => {
                    const n = run!.nodes[id];
                    return n.status === "queued" || n.status === "running";
                })
                .sort();
            shouldAdoptOrphans = activeNodeIds.length > 0 && activeNodeIds[0] === nodeId;
        }

        const result = this.chatManager.consumeMessages(runId, (msg) => {
            // 1. Direct match
            if (msg.nodeId === nodeId) return true;

            // 2. Global message (no nodeId) assigned to this node?
            // Usually global messages go to root (orphans) or if explicitly undefined?
            if (msg.nodeId === undefined) {
                // For now, treat undefined as orphan-candidate or broadcast?
                // Original logic treated undefined as "unassigned".
            }

            // 3. Orphans
            if (shouldAdoptOrphans) {
                // If message has no target OR target is terminated
                if (!msg.nodeId) return true;

                const target = run?.nodes[msg.nodeId];
                if (target && (target.status === "completed" || target.status === "failed" || target.status === "skipped")) {
                    return true;
                }
                if (!target) return true; // Node deleted?
            }
            return false;
        });

        return result.formatted || undefined;
    }

    private consumeEnvelopes(runId: string, nodeId: string): Envelope[] {
        const run = this.store.getRun(runId);
        if (!run) return [];

        const incomingEdges = Object.values(run.edges).filter(e => e.to === nodeId);
        const consumed: Envelope[] = [];
        let updated = false;

        for (const edge of incomingEdges) {
            if (edge.pendingEnvelopes && edge.pendingEnvelopes.length > 0) {
                consumed.push(...edge.pendingEnvelopes);
                edge.pendingEnvelopes = [];
                updated = true;
            }
        }

        if (updated) this.store.persistRun(run);
        return consumed;
    }

    private dispatchOutput(runId: string, nodeId: string, output: unknown): void {
        const run = this.store.getRun(runId);
        if (!run) return;

        const outgoingEdges = Object.values(run.edges).filter(e => e.from === nodeId);
        for (const edge of outgoingEdges) {
            const envelope: Envelope = {
                kind: "handoff",
                fromNodeId: nodeId,
                toNodeId: edge.to,
                payload: {
                    message: String(output), // Simple cast for now
                    structured: typeof output === 'object' ? output as any : undefined
                }
            };
            if (!edge.pendingEnvelopes) edge.pendingEnvelopes = [];
            edge.pendingEnvelopes.push(envelope);

            this.bus.emitHandoffSent(runId, nodeId, edge.to, edge.id, {});

            // Wake up target
            const target = run.nodes[edge.to];
            if (target && target.status !== "running" && target.control !== "MANUAL") {
                target.status = "queued";
                this.bus.emitNodePatch(runId, target.id, { status: "queued" }, "node.progress");
            }
        }
        this.store.persistRun(run);
    }
}
