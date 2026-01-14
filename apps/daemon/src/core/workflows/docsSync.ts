
import fs from "node:fs";
import { NodeRecord, DocsInventory, DocsIterationPlan } from "../types.js";
import { PromptFactory } from "../promptFactory.js";
import { RunStore } from "../store.js";
import { EventBus } from "../eventBus.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { OrchestratorConfig } from "../orchestrator.js";
import { ProviderAdapter } from "../../providers/types.js";
import { nowIso } from "../time.js";

interface OrchestratorContext {
    store: RunStore;
    bus: EventBus;
    providers: ProviderRegistry;
    cfg: OrchestratorConfig;
    createTaskNode: (params: any) => NodeRecord;
    createEdge: (runId: string, from: string, to: string, type: any, label?: string) => void;
    runProviderNode: (node: NodeRecord, provider: ProviderAdapter, args: any, signal: AbortSignal) => Promise<unknown>;
    roleProvider: (role: string) => ProviderAdapter;
    detectDocsInventory: (repoPath: string) => DocsInventory;
    transitionPhase: (runId: string, phase: any, reason?: string) => void;
}

type DocsSyncResult = {
    ok: boolean;
    hasChanges: boolean;
    summary: string;
};

export class DocsSyncWorkflow {
    constructor(
        private ctx: OrchestratorContext,
        private promptFactory: PromptFactory
    ) { }

    /**
     * Run the DOCS_SYNC phase - updates docs to match implementation reality.
     */
    async run(
        runId: string,
        rootNodeId: string,
        getSignal: () => AbortSignal
    ): Promise<DocsSyncResult> {
        const run = this.ctx.store.getRun(runId);
        if (!run) return { ok: false, hasChanges: false, summary: "" };

        this.ctx.transitionPhase(runId, "DOCS_SYNC", "Syncing documentation with implementation");
        this.ctx.bus.emitNodeProgress(runId, rootNodeId, "DOCS_SYNC: Updating documentation to match implementation...");

        // 1. Collect changes from the run
        const changesSummary = this.collectChangesSummary(runId);

        if (!changesSummary.hasChanges) {
            this.ctx.bus.emitNodeProgress(runId, rootNodeId, "DOCS_SYNC: No significant changes to document.");
            run.docsInventory = this.ctx.detectDocsInventory(run.repoPath);
            this.ctx.store.persistRun(run);
            return { ok: true, hasChanges: false, summary: "" };
        }

        // 2. Create doc update node
        const docUpdateNode = this.ctx.createTaskNode({
            runId,
            parentNodeId: rootNodeId,
            label: "Update Docs",
            role: "implementer",
            providerId: this.ctx.cfg.roles["planner"] ?? "mock",
        });
        this.ctx.createEdge(runId, rootNodeId, docUpdateNode.id, "handoff", "doc update");

        await this.ctx.runProviderNode(docUpdateNode, this.ctx.roleProvider("planner"), {
            prompt: this.promptFactory.buildDocsSyncPrompt(run, changesSummary),
        }, getSignal());
        this.ctx.createEdge(runId, docUpdateNode.id, rootNodeId, "report", "doc update result");

        // 3. Generate changelog entry
        const changelogNode = this.ctx.createTaskNode({
            runId,
            parentNodeId: rootNodeId,
            label: "Update Changelog",
            role: "implementer",
            providerId: this.ctx.cfg.roles["planner"] ?? "mock",
        });
        this.ctx.createEdge(runId, rootNodeId, changelogNode.id, "handoff", "changelog");

        await this.ctx.runProviderNode(changelogNode, this.ctx.roleProvider("planner"), {
            prompt: this.promptFactory.buildChangelogPrompt(run, changesSummary),
        }, getSignal());
        this.ctx.createEdge(runId, changelogNode.id, rootNodeId, "report", "changelog result");

        // 4. Final doc review
        const finalReviewNode = this.ctx.createTaskNode({
            runId,
            parentNodeId: rootNodeId,
            label: "Final Doc Review",
            role: "reviewer",
            providerId: this.ctx.cfg.roles["reviewer"] ?? this.ctx.cfg.roles["planner"] ?? "mock",
        });
        this.ctx.createEdge(runId, rootNodeId, finalReviewNode.id, "gate", "final review");

        await this.ctx.runProviderNode(finalReviewNode, this.ctx.roleProvider("reviewer"), {
            prompt: this.promptFactory.buildFinalDocReviewPrompt(run),
        }, getSignal());
        this.ctx.createEdge(runId, finalReviewNode.id, rootNodeId, "report", "final review result");

        this.ctx.bus.emitNodeProgress(runId, rootNodeId, "DOCS_SYNC: Documentation sync complete.");

        run.docsInventory = this.ctx.detectDocsInventory(run.repoPath);
        this.ctx.store.persistRun(run);

        const summaryPayload = {
            hasChanges: changesSummary.hasChanges,
            filesChanged: changesSummary.filesChanged,
            summary: changesSummary.summary,
        };
        const summaryArtifact = this.ctx.store.createArtifact({
            runId,
            nodeId: rootNodeId,
            kind: "json",
            name: "docs.sync.summary.json",
            mimeType: "application/json",
            content: JSON.stringify(summaryPayload, null, 2),
        });
        this.ctx.bus.emitArtifact(runId, summaryArtifact);

        return {
            ok: true,
            hasChanges: true,
            summary: changesSummary.summary,
        };
    }

    /**
     * Collect a summary of changes made during the run.
     */
    private collectChangesSummary(runId: string): { hasChanges: boolean; filesChanged: string[]; summary: string } {
        const run = this.ctx.store.getRun(runId);
        if (!run) return { hasChanges: false, filesChanged: [], summary: "" };

        const filesChanged: string[] = [];
        let summary = "";

        // Look for git diff artifacts
        const diffArtifacts = Object.values(run.artifacts)
            .filter((a) => a.kind === "diff" || a.name.includes("git.diff"))
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

        for (const art of diffArtifacts) {
            try {
                const content = fs.readFileSync(art.path, "utf-8");
                if (content.trim()) {
                    summary += `\n\n## Changes from ${art.name}:\n${content.slice(0, 2000)}`;
                    // Extract file names from diff
                    const fileMatches = content.match(/^(?:diff --git a\/|[-+]{3} [ab]\/)(.+)$/gm);
                    if (fileMatches) {
                        for (const match of fileMatches) {
                            const file = match.replace(/^(?:diff --git a\/|[-+]{3} [ab]\/)/, "").trim();
                            if (!filesChanged.includes(file)) filesChanged.push(file);
                        }
                    }
                }
            } catch {
                // ignore
            }
        }

        return {
            hasChanges: filesChanged.length > 0 || summary.length > 0,
            filesChanged,
            summary: summary.trim(),
        };
    }
}
