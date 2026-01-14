import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

import { RunStore } from "./store.js";
import { EventBus } from "./eventBus.js";
import { ProviderRegistry } from "../providers/registry.js";
import { ProviderAdapter, ProviderOutputEvent } from "../providers/types.js";
import { WorkspaceManager } from "./workspace.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { ApprovalQueue } from "./approvalQueue.js";
import { PromptFactory } from "./promptFactory.js";
import { ContextPackBuilder } from "./contextPackBuilder.js";
import { NodeRecord, Envelope, ManualTurnOptions, RunPhase, RoleId } from "./types.js";
import { nowIso } from "./time.js";

interface GraphCommandSpawn {
    command: "spawn_node";
    args: {
        role: RoleId;
        label: string;
        instructions: string;
        input?: Record<string, unknown>;
    };
}

type GraphCommand = GraphCommandSpawn;

function parseGraphCommand(text: string): GraphCommand | null {
    try {
        // Look for JSON block
        const match = text.match(/```json\s*(\{[\s\S]*?"command"\s*:\s*"spawn_node"[\s\S]*?\})\s*```/) ||
            text.match(/(\{[\s\S]*?"command"\s*:\s*"spawn_node"[\s\S]*?\})/);

        if (match) {
            const json = JSON.parse(match[1]);
            if (json.command === "spawn_node" && json.args) {
                return json as GraphCommand;
            }
        }
    } catch (e) {
        // ignore parse errors
    }
    return null;
}

export class NodeExecutor {
    constructor(
        private store: RunStore,
        private bus: EventBus,
        private providers: ProviderRegistry,
        private workspace: WorkspaceManager,
        private sessionRegistry: SessionRegistry,
        private approvalQueue: ApprovalQueue,
        private promptFactory: PromptFactory,
        // Callback for phase transitions or graph commands that need orchestration level handling
        private onGraphCommand: (runId: string, parentNodeId: string, cmd: GraphCommand) => string,
        private onPhaseTransition: (runId: string, phase: RunPhase, reason: string) => void
    ) { }

    /**
     * Execute a single node turn.
     */
    async executeNode(
        runId: string,
        nodeId: string,
        inputEnvelopes: Envelope[],
        signal: AbortSignal,
        getGlobalMode: () => string,
        additionalPromptText?: string
    ): Promise<void> {
        const run = this.store.getRun(runId);
        if (!run) return;
        const node = run.nodes[nodeId];
        if (!node) return;

        // Mark as running
        this.bus.emitNodePatch(runId, nodeId, { status: "running", startedAt: nowIso() }, "node.started");

        try {
            // Determine Provider
            const providerId = node.providerId ?? "mock";
            const provider = this.providers.get(providerId);

            if (!provider) {
                throw new Error(`Provider not found: ${providerId}`);
            }

            // Prepare Prompt/Context
            let prompt = "";
            const effectiveMode = getGlobalMode();
            let systemPreamble = "";

            if (effectiveMode === "PLANNING") {
                systemPreamble = "MODE: PLANNING. You are in read-only planning mode.\n" +
                    "- You MAY read files and docs.\n" +
                    "- You MAY write/update files in /docs/.\n" +
                    "- You MUST NOT write code files or modify the implementation.\n" +
                    "- If you need to implement changes, ask the user to switch to IMPLEMENTATION mode.\n\n";
            } else {
                systemPreamble = "MODE: IMPLEMENTATION. You are in implementation mode.\n" +
                    "- You MAY write code and modify the implementation.\n" +
                    "- Ensure you have a plan before making changes.\n\n";
            }

            systemPreamble += `CAPABILITY: You have the ability to spawn sub-agents to delegate work.
To spawn a node, output a JSON block with the following structure:
\`\`\`json
{
  "command": "spawn_node",
  "args": {
    "role": "implementer", // or "planner", "reviewer", "investigator"
    "label": "Agent Name",
    "instructions": "Specific instructions for the agent...",
    "input": { ... }
  }
}
\`\`\`
Use this when you need to paralellize work or delegate a specific sub-task.\n\n`;

            // Context Block construction
            let contextBlock = "";
            if (node.input && typeof node.input === "object") {
                const input = node.input as Record<string, unknown>;
                if (input["system_alert"]) {
                    contextBlock += `\nSYSTEM ALERT: ${input["system_alert"]}\n\n`;
                }
                if (input["repoFacts"]) {
                    contextBlock += `Repo Context: ${JSON.stringify(input["repoFacts"])}\n`;
                }
                if (input["docsInventory"]) {
                    contextBlock += `Docs Inventory: ${JSON.stringify(input["docsInventory"])}\n`;
                }
            }

            // Prompt Construction logic
            if (nodeId === run.rootOrchestratorNodeId && (!node.turnCount || node.turnCount === 0) && inputEnvelopes.length === 0) {
                prompt = (run.prompt || "Ready for instructions.") + "\n" + contextBlock;
            } else if (inputEnvelopes.length > 0) {
                // Build prompt from envelopes
                prompt = "Incoming transmissions:\n\n";
                for (const env of inputEnvelopes) {
                    prompt += `--- From Node ${env.fromNodeId} ---\n`;
                    prompt += `${env.payload.message ?? "(No message)"}\n`;
                    if (env.payload.structured) {
                        prompt += `Data: ${JSON.stringify(env.payload.structured, null, 2)}\n`;
                    }
                    if (env.payload.artifacts?.length) {
                        prompt += `Artifacts: ${env.payload.artifacts.map(a => a.ref).join(", ")}\n`;
                    }
                    prompt += "\n";
                }
                prompt += "\nBased on the above inputs, proceed with your task.";
            } else {
                // Tick-based
                const lastOutput = node.output ? JSON.stringify(node.output).slice(0, 500) : "none";

                // If there are chat messages, clarify when to output DONE vs continue conversation
                if (additionalPromptText) {
                    prompt = `Tick (Loop Continuation).\n` +
                        `Global Mode: ${effectiveMode}\n` +
                        `Previous Output: ${lastOutput}\n\n` +
                        `The user has sent you a message. Respond appropriately.\n` +
                        `- If they gave you a task and you have completed it, output { "status": "DONE" }.\n` +
                        `- If you need more information or clarification, ask and wait.`;
                } else {
                    prompt = `Tick (Loop Continuation).\n` +
                        `Global Mode: ${effectiveMode}\n` +
                        `Previous Output: ${lastOutput}\n\n` +
                        `Continue execution. If task is done, output { "status": "DONE" }.`;
                }
            }

            let finalPrompt = systemPreamble + prompt;

            // Append injected chat
            if (additionalPromptText) {
                finalPrompt += "\n" + additionalPromptText;
            }

            // Emit turn started
            const turnNum = (node.turnCount ?? 0) + 1;
            this.bus.emitTurnStarted(runId, nodeId, randomUUID(), turnNum, false, finalPrompt);

            this.bus.emitNodeProgress(runId, nodeId, "Executing...");

            const output = await this.runProviderTask(runId, node, provider, { prompt: finalPrompt }, signal);

            // On success: Output is returned. The caller (Scheduler) handles dispatching to edges.

            // Check for DONE signal
            let isDone = false;
            if (typeof output === "object" && output !== null && !Array.isArray(output)) {
                const rec = output as Record<string, unknown>;
                if (rec["status"] === "DONE") isDone = true;

                if (rec["action"] === "transition_phase" && typeof rec["phase"] === "string") {
                    this.onPhaseTransition(runId, rec["phase"] as RunPhase, "Agent requested transition");
                }
            }
            if (typeof output === "string" && output.includes("DONE")) isDone = true;

            // Stall Detection
            const outputHash = this.computeOutputHash(output);
            const { stallCount, lastFailureSignature } = this.computeGenericStallState(node, outputHash);

            // Task Linkage: Update DAG status
            if (node.taskId && run.taskDag) {
                const step = run.taskDag.steps.find((s) => s.id === node.taskId);
                if (step) {
                    step.status = "completed";
                    step.nodeId = node.id;
                    this.bus.emitNodeProgress(runId, node.id, `[TASK] Marked step '${step.id}' as completed.`);
                }
            }

            const nodePatch: Partial<NodeRecord> = {
                status: "completed",
                completedAt: nowIso(),
                stallCount,
                lastFailureSignature,
                output // Update output on node
            };

            this.bus.emitNodePatch(runId, nodeId, nodePatch, "node.completed");

            // Update Node Turn Count
            node.turnCount = (node.turnCount ?? 0) + 1;
            this.store.persistRun(run);

        } catch (error: any) {
            if (signal.aborted || error.message === "aborted") {
                this.bus.emitNodePatch(runId, nodeId, { status: "queued" }, "node.progress");
            } else {
                this.bus.emitNodePatch(runId, nodeId, { status: "failed", error: { message: error.message } }, "node.failed");
            }
            throw error;
        }
    }

    async executeManual(
        runId: string,
        nodeId: string,
        userMessage: string,
        // Optional: consume messages callback to inject pending chat
        consumePendingMessages?: () => string
    ): Promise<{ success: boolean; error?: string; output?: unknown }> {
        const run = this.store.getRun(runId);
        if (!run) return { success: false, error: "Run not found" };

        const node = run.nodes[nodeId];
        if (!node) return { success: false, error: "Node not found" };

        // Mark starting
        this.bus.emitNodePatch(runId, nodeId, { status: "running", startedAt: nowIso() }, "node.started");

        try {
            const providerId = node.providerId ?? "mock";
            const provider = this.providers.get(providerId);
            if (!provider) throw new Error("Provider not found");

            // Build manual prompt
            const basePrompt = this.promptFactory.buildManualTurnPrompt(userMessage);
            const chatSection = consumePendingMessages ? consumePendingMessages() : "";
            const finalPrompt = chatSection ? basePrompt + "\n" + chatSection : basePrompt;

            // Emit turn started
            const turnNum = (node.turnCount ?? 0) + 1;
            const turnId = randomUUID();
            this.bus.emitTurnStarted(runId, nodeId, turnId, turnNum, true, userMessage);

            const abortController = new AbortController();

            const output = await this.runProviderTask(runId, node, provider, { prompt: finalPrompt }, abortController.signal);

            this.bus.emitTurnCompleted(runId, nodeId, turnId, turnNum, true, { content: typeof output === 'string' ? output : JSON.stringify(output) });

            // Update node
            node.turnCount = turnNum;
            node.output = output;
            this.bus.emitNodePatch(runId, nodeId, { status: "completed", output }, "node.completed");
            this.store.persistRun(run);

            return { success: true, output };

        } catch (e: any) {
            this.bus.emitNodePatch(runId, nodeId, { status: "failed", error: { message: e.message } }, "node.failed");
            return { success: false, error: e.message };
        }
    }

    public async runProviderTask(
        runId: string,
        node: NodeRecord,
        provider: ProviderAdapter,
        params: { prompt: string; outputSchemaName?: "plan" | "repo-brief" },
        signal: AbortSignal
    ): Promise<unknown> {
        const wsPath = await this.workspace.prepareWorkspace({
            repoPath: this.store.getRun(runId)!.repoPath,
            runId,
            nodeId: node.id,
        });
        this.bus.emitNodePatch(runId, node.id, { status: "running", startedAt: nowIso(), workspacePath: wsPath }, "node.started");

        // Session logic
        const existingSession = this.sessionRegistry.getByNodeId(node.id);
        const sessionId = node.providerSessionId ?? existingSession?.providerSessionId;

        let finalOutput: unknown = undefined;

        const run = this.store.getRun(runId);
        // Default to skipping CLI permissions unless explicitly disabled in policy
        const skipCliPermissions = run?.policy?.skipCliPermissions ?? true;
        const iter = provider.runTask({
            runId,
            nodeId: node.id,
            role: node.role ?? "implementer",
            prompt: params.prompt,
            workspacePath: wsPath,
            sessionId,
            skipPermissions: skipCliPermissions,
        }, signal);

        for await (const ev of iter) {
            if (signal.aborted) throw new Error("aborted");
            await this.handleProviderEvent(ev, runId, node, provider);

            if (ev.type === "final") {
                finalOutput = ev.output;
            } else if (ev.type === "message.final") {
                finalOutput = ev.content;
            }
            if (ev.type === "json" && String(ev.name).includes("plan")) {
                finalOutput = ev.json;

                // --- Task DAG Parsing (V0 Implementation) ---
                if (typeof ev.json === 'object' && ev.json) {
                    const plan = ev.json as any;
                    if (plan.taskDag && Array.isArray(plan.taskDag.steps)) {
                        const run = this.store.getRun(runId);
                        if (run) {
                            run.taskDag = plan.taskDag;
                            if (Array.isArray(plan.acceptanceCriteria)) {
                                run.acceptanceCriteria = plan.acceptanceCriteria;
                            }
                            // Persist implementation plan to run
                            this.store.persistRun(run);
                            this.bus.emitRunPatch(runId, {
                                id: runId,
                                taskDag: run.taskDag,
                                acceptanceCriteria: run.acceptanceCriteria
                            }, "run.updated");
                            this.bus.emitNodeProgress(runId, node.id, `[PLAN] Parsed ${run.taskDag?.steps.length} steps and ${run.acceptanceCriteria?.length} criteria.`);
                        }
                    }
                }
            }
        }

        // Graph Command Interception
        if (typeof finalOutput === "string") {
            const cmd = parseGraphCommand(finalOutput);
            if (cmd) {
                const result = this.onGraphCommand(runId, node.id, cmd);
                finalOutput += "\n\n" + result;
            }
        }

        // Git Diff Capture
        const diff = this.workspace.captureGitDiff(wsPath);
        if (diff.ok && (diff.diff.trim().length || diff.status.trim().length)) {
            const diffArt = this.store.createArtifact({
                runId,
                nodeId: node.id,
                kind: "diff",
                name: "git.diff.patch",
                mimeType: "text/plain",
                content: diff.diff,
                meta: { source: "git diff" },
            });
            this.bus.emitArtifact(runId, diffArt);
        }

        return finalOutput;
    }

    private async handleProviderEvent(
        ev: ProviderOutputEvent,
        runId: string,
        node: NodeRecord,
        provider: ProviderAdapter
    ): Promise<void> {
        switch (ev.type) {
            case "progress":
                this.bus.emitNodeProgress(runId, node.id, ev.message, ev.raw);
                break;
            case "log":
            case "json":
            case "diff": {
                const kind = ev.type === "json" ? "json" : (ev.type === "diff" ? "diff" : "log");
                const mime = ev.type === "json" ? "application/json" : "text/plain";
                const content = ev.type === "json" ? JSON.stringify(ev.json, null, 2) :
                    (ev.type === "diff" ? ev.patch : ev.content);

                const art = this.store.createArtifact({
                    runId,
                    nodeId: node.id,
                    kind,
                    name: ev.name,
                    mimeType: mime,
                    content: content,
                });
                this.bus.emitArtifact(runId, art);
                break;
            }
            case "session":
                node.providerSessionId = ev.sessionId;
                this.sessionRegistry.register({
                    nodeId: node.id,
                    runId,
                    providerId: provider.id,
                    providerSessionId: ev.sessionId,
                });
                // We do NOT persist run here to minimize IO, caller persists after execution
                break;
            case "message.delta":
                this.bus.emitMessageDelta(runId, node.id, ev.delta, ev.index);
                break;
            case "message.final":
                this.bus.emitMessageFinal(runId, node.id, ev.content, ev.tokenCount);
                break;
            case "tool.proposed": {
                // Emit tool proposed event for UI visibility
                this.bus.emitToolProposed(runId, node.id, ev.tool);

                // Check if CLI permissions are enabled (not skipped)
                const run = this.store.getRun(runId);
                const permissionsEnabled = !(run?.policy?.skipCliPermissions ?? true);

                // When permissions are enabled, request approval and forward response to CLI
                if (permissionsEnabled) {
                    try {
                        const resolution = await this.approvalQueue.requestApproval({
                            runId,
                            nodeId: node.id,
                            tool: ev.tool,
                            context: `Tool: ${ev.tool.name}\nArgs: ${JSON.stringify(ev.tool.args, null, 2)}`,
                        });

                        // Send approval response to CLI stdin
                        if (provider.sendApprovalResponse) {
                            const approved = resolution.status === "approved" || resolution.status === "modified";
                            provider.sendApprovalResponse(
                                node.id,
                                ev.tool.id,
                                approved,
                                resolution.modifiedArgs
                            );
                        }

                        if (resolution.status === "denied") {
                            this.bus.emitNodeProgress(runId, node.id, `Tool ${ev.tool.name} denied: ${resolution.feedback ?? "user denied"}`);
                        } else if (resolution.status === "modified" && resolution.modifiedArgs) {
                            this.bus.emitNodeProgress(runId, node.id, `Tool ${ev.tool.name} approved with modifications`);
                        }
                    } catch {
                        // Approval request failed or timed out
                        this.bus.emitNodeProgress(runId, node.id, `Tool ${ev.tool.name} approval failed/timed out`);
                    }
                }
                break;
            }
            case "tool.started":
                this.bus.emitToolStarted(runId, node.id, ev.toolId);
                break;
            case "tool.completed":
                this.bus.emitToolCompleted(runId, node.id, ev.toolId, ev.result, ev.error, ev.durationMs);
                break;
        }
    }

    private computeOutputHash(output: unknown): string {
        const content = typeof output === "string" ? output : JSON.stringify(output);
        return createHash("sha256").update(content ?? "").digest("hex").slice(0, 16);
    }

    private computeGenericStallState(
        node: NodeRecord,
        outputHash: string
    ): { stallCount: number; lastFailureSignature?: string } {
        const previousHash = node.lastFailureSignature;
        const previousCount = node.stallCount ?? 0;
        const stallCount = previousHash === outputHash ? previousCount + 1 : 1;
        return { stallCount, lastFailureSignature: outputHash };
    }
}
