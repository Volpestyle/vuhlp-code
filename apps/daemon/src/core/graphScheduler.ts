import { EventEmitter } from "node:events";
import { Semaphore } from "./scheduler.js";
import { RunStore } from "./store.js";
import { EventBus } from "./eventBus.js";
import { ChatManager } from "./chatManager.js";
import { NodeExecutor } from "./nodeExecutor.js";
import { RunRecord, Envelope } from "./types.js";
import { log } from "./logger.js";

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
        if (this.activeLoops.has(runId)) {
            log.debug("Scheduler already running for run", { runId });
            return;
        }

        log.info("Starting scheduler", { runId, maxConcurrency: this.config.maxConcurrency });

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
            log.info("Scheduler stopped", { runId });
            this.activeLoops.delete(runId);
            this.loopControllers.delete(runId);
            this.pauseSignals.delete(runId);
        }
    }

    stop(runId: string): void {
        log.info("Stopping scheduler", { runId });
        const controller = this.loopControllers.get(runId);
        if (controller) {
            controller.abort();
        }
        // resolve pause so loop exits
        const pause = this.pauseSignals.get(runId);
        if (pause) pause.resolve();
    }

    pause(runId: string): boolean {
        if (!this.activeLoops.has(runId)) {
            log.debug("Cannot pause: scheduler not running", { runId });
            return false;
        }
        if (this.pauseSignals.has(runId)) {
            log.debug("Scheduler already paused", { runId });
            return true;
        }

        log.info("Pausing scheduler", { runId });
        let resolve: () => void = () => { };
        const promise = new Promise<void>((r) => { resolve = r; });
        this.pauseSignals.set(runId, { resolve, promise });

        return true;
    }

    resume(runId: string): boolean {
        const pause = this.pauseSignals.get(runId);
        if (!pause) {
            log.debug("Cannot resume: scheduler not paused", { runId });
            return false;
        }

        log.info("Resuming scheduler", { runId });
        pause.resolve();
        this.pauseSignals.delete(runId);

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
                        // DRY RUN CHECK: prevent infinite wake-up loops
                        // Only wake up if the node will ACTUALLY consume the message.
                        const wouldConsume = this.consumeChatMessages(runId, nodeId, { dryRun: true });

                        if (wouldConsume) {
                            node.status = "queued";
                            this.bus.emitNodePatch(runId, nodeId, { status: "queued" }, "node.progress");
                            wokenCount++;
                        } else {
                            // Can't consume? Then don't wake it. It might be waiting for other conditions/inputs.
                            // If it's a "global" message not addressed to anyone, and NOONE consumes it, it stays pending.
                            // That's fine, better than spinning.
                        }
                    }
                }
                if (wokenCount > 0) this.store.persistRun(run);
            }

            if (isInteractive) {
                // In interactive mode, we ONLY proceed if we have pending messages OR if we have explicitly queued nodes 
                // that might have been queued by a previous step (handoffs).

                // If there are NO pending messages AND NO ready nodes, we pause.
                if (pendingMessages.length === 0) {
                    const queuedNodes = this.getReadyNodes(runId);
                    if (queuedNodes.length === 0) {
                        await new Promise(r => setTimeout(r, 500));
                        continue;
                    }
                }
            }

            // 3. Scan for Ready Nodes
            const readyNodes = this.getReadyNodes(runId);

            if (readyNodes.length > 0) {
                log.debug("Scheduler tick: found ready nodes", {
                    runId,
                    readyCount: readyNodes.length,
                    inFlightCount: this.inFlight.size
                });
            }

            for (const nodeId of readyNodes) {
                if (this.inFlight.has(nodeId)) continue;

                this.inFlight.add(nodeId);
                log.debug("Queuing node for execution", { runId, nodeId, inFlightCount: this.inFlight.size });

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

                        // Dispatch output to connected edges
                        const updatedRun = this.store.getRun(runId);
                        const updatedNode = updatedRun?.nodes[nodeId];
                        if (updatedNode?.status === "completed") {
                            this.dispatchOutput(runId, nodeId, updatedNode.output);
                        }

                    } catch (e) {
                        const err = e instanceof Error ? e : new Error(String(e));
                        log.error("Scheduler: node execution failed", {
                            runId,
                            nodeId,
                            error: err.message
                        });
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

    private consumeChatMessages(runId: string, nodeId: string, options?: { dryRun?: boolean }): string | undefined {
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
        }, options?.dryRun);

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

        // Loop Breaker / Noise Suppression
        // If the output is a simple acknowledgment or "DONE" status, we suppress dispatch
        // to prevent infinite "Report" -> "Ack" -> "Report" loops between agents.
        let shouldDispatchPayload = true;

        if (typeof output === 'string') {
            const s = output.trim();
            if (s.length === 0) shouldDispatchPayload = false;
            else {
                // Remove punctuation and lowercase
                const lower = s.toLowerCase().replace(/[.,!]/g, '');
                const stopWords = new Set([
                    "done", "ok", "okay", "received", "acknowledged",
                    "good", "great", "thanks", "thank you", "no problem",
                    "understood", "copy that", "affirmatve", "rogue"
                ]);

                // Allow up to 2 words (e.g. "Done." or "Copy that")
                const wordCount = lower.split(/\s+/).length;

                if (wordCount <= 3 && (stopWords.has(lower) || stopWords.has(lower.split(' ')[0]))) {
                    shouldDispatchPayload = false;
                }

                // Check for JSON-like status: DONE in string format
                if (s.match(/^\{?\s*"status":\s*"DONE"\s*\}?$/i)) {
                    shouldDispatchPayload = false;
                }
            }
        } else if (typeof output === 'object' && output) {
            const rec = output as Record<string, unknown>;
            // If it's just { status: "DONE" } with no other data
            if (rec.status === 'DONE') {
                // Check if there are other meaningful fields (ignore 'action' which is internal)
                const keys = Object.keys(rec).filter(k => k !== 'status' && k !== 'action');
                if (keys.length === 0) shouldDispatchPayload = false;
            }
        }

        if (!shouldDispatchPayload) {
            log.info("GraphScheduler: Suppressing payload dispatch (Ack/Done)", { runId, nodeId });
        }

        const outgoingEdges = Object.values(run.edges).filter(e => e.from === nodeId);
        // Also find reverse edges (where we are the target, but it's bidirectional)
        const reverseEdges = Object.values(run.edges).filter(e => e.to === nodeId && e.bidirectional);

        const allActiveEdges = [...outgoingEdges, ...reverseEdges];

        for (const edge of allActiveEdges) {
            // Determine target
            const targetNodeId = edge.from === nodeId ? edge.to : edge.from;

            // Handoff/Report Edges (Data Flow)
            if (shouldDispatchPayload && (edge.type === "handoff" || edge.type === "report" || edge.type === "default")) {
                const envelope: Envelope = {
                    kind: "handoff",
                    fromNodeId: nodeId,
                    toNodeId: targetNodeId,
                    payload: {
                        message: String(output), // Simple cast for now
                        structured: typeof output === 'object' ? output as any : undefined
                    }
                };
                if (!edge.pendingEnvelopes) edge.pendingEnvelopes = [];
                edge.pendingEnvelopes.push(envelope);

                this.bus.emitHandoffSent(runId, nodeId, targetNodeId, edge.id, {});

                // Wake up target if it was just waiting for data (queued/running nodes are handled by loop)
                const target = run.nodes[targetNodeId];
                if (target && target.status !== "running" && target.control !== "MANUAL") {
                    target.status = "queued";
                    this.bus.emitNodePatch(runId, target.id, { status: "queued" }, "node.progress");
                }
            }
        }
        this.store.persistRun(run);
    }
}
