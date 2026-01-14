
import path from "node:path";
import { NodeRecord, DocsInventory, DocsIterationPlan } from "../types.js";
import { PromptFactory } from "../promptFactory.js";
import { Semaphore } from "../scheduler.js";
import { RunStore } from "../store.js";
import { EventBus } from "../eventBus.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { OrchestratorConfig } from "../orchestrator.js";
import { nowIso } from "../time.js";
import { ProviderAdapter } from "../../providers/types.js";

// Helper type for abstracting the orchestrator implementation details we need
interface OrchestratorContext {
    store: RunStore;
    bus: EventBus;
    providers: ProviderRegistry;
    cfg: OrchestratorConfig;
    createTaskNode: (params: any) => NodeRecord;
    createEdge: (runId: string, from: string, to: string, type: any, label?: string) => void;
    runProviderNode: (node: NodeRecord, provider: ProviderAdapter, args: any, signal: AbortSignal) => Promise<unknown>;
    checkPause: (runId: string) => Promise<void>;
    shouldStopScheduling: (runId: string) => boolean;
    pauseSignals: Map<string, any>;
    roleProvider: (role: string) => ProviderAdapter;
    detectDocsInventory: (repoPath: string) => DocsInventory;
}

export class DocsIterationWorkflow {
    constructor(
        private ctx: OrchestratorContext,
        private promptFactory: PromptFactory
    ) { }

    /**
     * Build a docs iteration plan based on missing docs.
     */
    private buildDocsIterationPlan(run: { docsInventory?: DocsInventory; prompt: string }): DocsIterationPlan {
        const inventory = run.docsInventory;
        const missingDocs = inventory?.missingRequired ?? [];
        const tasks: DocsIterationPlan["docAgentTasks"] = [];

        // Map missing docs to doc agent tasks
        for (const doc of missingDocs) {
            const docLower = doc.toLowerCase();

            if (docLower.includes("architecture")) {
                tasks.push({
                    id: "draft-architecture",
                    role: "architecture-drafter",
                    targetDoc: path.join(this.ctx.cfg.planning?.docsDirectory ?? "docs", "ARCHITECTURE.md"),
                    instructions: `Create an ARCHITECTURE.md document that describes the system architecture for the following project goal:\n\n${run.prompt}\n\nInclude sections for: Overview, Components, Data Flow, Key Decisions.`,
                    deps: [],
                });
            } else if (docLower.includes("overview")) {
                tasks.push({
                    id: "draft-overview",
                    role: "ux-spec-drafter",
                    targetDoc: path.join(this.ctx.cfg.planning?.docsDirectory ?? "docs", "OVERVIEW.md"),
                    instructions: `Create an OVERVIEW.md document that provides a high-level project overview for:\n\n${run.prompt}\n\nInclude sections for: Purpose, Scope, Key Features, Getting Started.`,
                    deps: [],
                });
            } else if (docLower.includes("plan")) {
                tasks.push({
                    id: "draft-plan",
                    role: "harness-integration-drafter",
                    targetDoc: path.join(this.ctx.cfg.planning?.docsDirectory ?? "docs", "PLAN.md"),
                    instructions: `Create a PLAN.md document with the implementation plan for:\n\n${run.prompt}\n\nInclude sections for: Goals, Milestones, Tasks, Timeline (phases not dates).`,
                    deps: ["draft-architecture"],
                });
            } else if (docLower.includes("acceptance")) {
                tasks.push({
                    id: "draft-acceptance",
                    role: "security-permissions-drafter",
                    targetDoc: path.join(this.ctx.cfg.planning?.docsDirectory ?? "docs", "ACCEPTANCE.md"),
                    instructions: `Create an ACCEPTANCE.md document with acceptance criteria for:\n\n${run.prompt}\n\nInclude sections for: Success Criteria, Verification Steps, Test Requirements.`,
                    deps: ["draft-plan"],
                });
            }
        }

        return { missingDocs, docAgentTasks: tasks };
    }

    /**
     * Run the DOCS_ITERATION phase - spawns doc agents to generate missing docs.
     */
    async run(
        runId: string,
        rootNodeId: string,
        getSignal: () => AbortSignal
    ): Promise<void> {
        const run = this.ctx.store.getRun(runId);
        if (!run) return;

        this.ctx.bus.emitNodeProgress(runId, rootNodeId, "DOCS_ITERATION: Generating missing documentation...");

        // 1. Build docs iteration plan
        const docsIterationPlan = this.buildDocsIterationPlan(run);

        if (docsIterationPlan.docAgentTasks.length === 0) {
            this.ctx.bus.emitNodeProgress(runId, rootNodeId, "DOCS_ITERATION: No doc tasks needed.");
            return;
        }

        // 2. Create doc nodes for each task
        const docNodes: Array<{ task: DocsIterationPlan["docAgentTasks"][0]; node: NodeRecord }> = [];

        for (const task of docsIterationPlan.docAgentTasks) {
            const providerId = this.ctx.cfg.roles[task.role] ?? this.ctx.cfg.roles["planner"] ?? "mock";
            const node = this.ctx.createTaskNode({
                runId,
                parentNodeId: rootNodeId,
                label: `Doc (${task.role}): ${path.basename(task.targetDoc)}`,
                role: "implementer", // Use implementer role with doc-specific prompt
                providerId,
            });
            docNodes.push({ task, node });
            this.ctx.createEdge(runId, rootNodeId, node.id, "handoff", `draft ${path.basename(task.targetDoc)}`);
        }

        // 3. Create dependency edges between doc nodes
        const byTaskId = new Map<string, string>();
        for (const dn of docNodes) {
            byTaskId.set(dn.task.id, dn.node.id);
        }
        for (const dn of docNodes) {
            for (const dep of dn.task.deps) {
                const depNodeId = byTaskId.get(dep);
                if (depNodeId) {
                    this.ctx.createEdge(runId, depNodeId, dn.node.id, "dependency", "depends on");
                }
            }
        }

        // 4. Execute doc drafts with DAG scheduling (similar to EXECUTE phase)
        const semaphore = new Semaphore(this.ctx.cfg.scheduler.maxConcurrency);
        const completed = new Set<string>();
        const running = new Map<string, Promise<void>>();

        const canRun = (dn: { task: DocsIterationPlan["docAgentTasks"][0]; node: NodeRecord }) => {
            for (const dep of dn.task.deps) {
                const depNodeId = byTaskId.get(dep);
                if (depNodeId && !completed.has(depNodeId)) return false;
            }
            return true;
        };

        const startDocTask = async (dn: { task: DocsIterationPlan["docAgentTasks"][0]; node: NodeRecord }) => {
            const release = await semaphore.acquire();
            try {
                await this.ctx.checkPause(runId);
                if (this.ctx.shouldStopScheduling(runId)) {
                    throw new Error("MODE_INTERACTIVE");
                }

                const provider = this.ctx.providers.get(dn.node.providerId ?? "mock") ?? this.ctx.roleProvider("planner");
                await this.ctx.runProviderNode(dn.node, provider, {
                    prompt: this.promptFactory.buildDocDraftPrompt(dn.task),
                }, getSignal());
                this.ctx.createEdge(runId, dn.node.id, rootNodeId, "report", "doc draft");
            } finally {
                release();
                completed.add(dn.node.id);
            }
        };

        // Main scheduling loop for doc tasks
        while (completed.size < docNodes.length) {
            if (getSignal().aborted) {
                if (!this.ctx.pauseSignals.has(runId)) throw new Error("Run aborted");
                throw new Error("PAUSED_INTERRUPT");
            }

            // Launch ready doc tasks
            for (const dn of docNodes) {
                if (completed.has(dn.node.id)) continue;
                if (running.has(dn.node.id)) continue;
                if (!canRun(dn)) continue;
                const p = startDocTask(dn).catch((e) => {
                    if (e.message === "PAUSED_INTERRUPT" || e.message === "aborted" || e.message === "MODE_INTERACTIVE") throw e;
                    this.ctx.bus.emitNodePatch(runId, dn.node.id, {
                        status: "failed",
                        completedAt: nowIso(),
                        error: { message: e?.message ?? String(e), stack: e?.stack },
                    }, "node.failed");
                });
                running.set(dn.node.id, p);
            }

            if (running.size === 0) {
                this.ctx.bus.emitNodeProgress(runId, rootNodeId, "DOCS_ITERATION: Deadlock in doc scheduling.");
                break;
            }

            try {
                await Promise.race([...running.values()]);
            } catch (e: unknown) {
                const errMessage = e instanceof Error ? e.message : String(e);
                if (errMessage === "PAUSED_INTERRUPT" || errMessage === "aborted" || errMessage === "MODE_INTERACTIVE") throw e;
            }

            for (const [nodeId] of [...running.entries()]) {
                if (completed.has(nodeId)) running.delete(nodeId);
            }
        }

        // 5. Run doc review gate
        this.ctx.bus.emitNodeProgress(runId, rootNodeId, "DOCS_ITERATION: Reviewing generated documentation...");

        const reviewNode = this.ctx.createTaskNode({
            runId,
            parentNodeId: rootNodeId,
            label: "Doc Review",
            role: "reviewer",
            providerId: this.ctx.cfg.roles["reviewer"] ?? this.ctx.cfg.roles["planner"] ?? "mock",
        });
        this.ctx.createEdge(runId, rootNodeId, reviewNode.id, "gate", "doc review");

        await this.ctx.runProviderNode(reviewNode, this.ctx.roleProvider("reviewer"), {
            prompt: this.promptFactory.buildDocReviewPrompt(run),
        }, getSignal());
        this.ctx.createEdge(runId, reviewNode.id, rootNodeId, "report", "doc review result");

        // Update docs inventory after generation
        run.docsInventory = this.ctx.detectDocsInventory(run.repoPath);
        this.ctx.store.persistRun(run);

        this.ctx.bus.emitNodeProgress(runId, rootNodeId, "DOCS_ITERATION: Documentation phase complete.");
    }
}
