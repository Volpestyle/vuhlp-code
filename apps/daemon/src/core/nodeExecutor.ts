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
import { log } from "./logger.js";

interface GraphCommandSpawn {
    command: "spawn_node";
    args: {
        role?: RoleId;
        label: string;
        instructions: string;
        input?: Record<string, unknown>;
        customSystemPrompt?: string;
        policy?: { allowedTools?: string[]; approvalMode?: "always" | "high_risk_only" | "never" };
    };
}

type GraphCommand = GraphCommandSpawn;

function relaxedJsonParse(text: string): any {
    try {
        return JSON.parse(text);
    } catch (e) {
        // Try strict parse failed, attempt to clean up
        let cleaned = text;

        // 1. Remove comments (simple regex, might be fragile but better than nothing)
        cleaned = cleaned.replace(/\/\/.*$/gm, ''); // Single line
        cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, ''); // Multi line

        // 2. Remove trailing commas
        cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

        try {
            return JSON.parse(cleaned);
        } catch (e2) {
            throw e; // Throw original error
        }
    }
}

function parseGraphCommand(text: string): GraphCommand | null {
    if (!text) return null;

    // Helper to validate and return the command
    const validate = (json: unknown): GraphCommand | null => {
        if (json && typeof json === 'object' && (json as Record<string, unknown>).command === "spawn_node" && (json as Record<string, unknown>).args) {
            const typedJson = json as GraphCommand;
            log.debug("Valid spawn_node command detected", { label: typedJson.args.label });
            return typedJson;
        }
        return null;
    };

    try {
        log.debug("Parsing graph command", { textLength: text.length });
        // 1. Try parsing Markdown Code Blocks
        // Relaxed regex to allow optional language tag
        const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
        let match;
        while ((match = codeBlockRegex.exec(text)) !== null) {
            try {
                const json = relaxedJsonParse(match[1]);
                const valid = validate(json);
                if (valid) return valid;
            } catch { /* ignore invalid json in blocks */ }
        }

        // 2. Try parsing the whole text (if it's just raw JSON)
        try {
            const json = relaxedJsonParse(text);
            const valid = validate(json);
            if (valid) return valid;
        } catch { /* ignore */ }

        // 3. Robust Brace Balancing (scan for top-level objects)
        let openBraces = 0;
        let startIndex = -1;
        let inString = false;
        let escaped = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            if (char === '"' && !escaped) {
                inString = !inString;
            }
            if (!inString && char === '\\') {
                escaped = !escaped;
            } else {
                escaped = false;
            }

            if (!inString) {
                if (char === '{') {
                    if (openBraces === 0) startIndex = i;
                    openBraces++;
                } else if (char === '}') {
                    openBraces--;
                    if (openBraces === 0 && startIndex !== -1) {
                        // Found a potential JSON object block
                        const block = text.substring(startIndex, i + 1);
                        try {
                            const json = relaxedJsonParse(block);
                            const valid = validate(json);
                            if (valid) return valid;
                        } catch { /* ignore invalid blocks */ }
                        startIndex = -1;
                    }
                }
            }
        }
    } catch (e) {
        log.warn("Graph command parse error", { error: e instanceof Error ? e.message : String(e) });
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
        const startTime = Date.now();
        const run = this.store.getRun(runId);
        if (!run) {
            log.warn("Cannot execute node: run not found", { runId, nodeId });
            return;
        }
        const node = run.nodes[nodeId];
        if (!node) {
            log.warn("Cannot execute node: node not found", { runId, nodeId });
            return;
        }



        log.info("Executing node", {
            runId,
            nodeId,
            label: node.label,
            role: node.role,
            providerId: node.providerId,
            turnCount: node.turnCount ?? 0,
            envelopeCount: inputEnvelopes.length,
            hasAdditionalPrompt: !!additionalPromptText
        });

        // Mark as running
        this.bus.emitNodePatch(runId, nodeId, { status: "running", startedAt: nowIso() }, "node.started");

        try {
            // Determine Provider
            const providerId = node.providerId ?? "mock";
            const provider = this.providers.get(providerId);

            if (!provider) {
                log.error("Provider not found for node", { runId, nodeId, providerId });
                throw new Error(`Provider not found: ${providerId}`);
            }

            // Prepare Prompt/Context
            const effectiveMode = getGlobalMode();

            // 1. System Specification (Architectural Vision)
            let finalPrompt = this.promptFactory.buildSystemContext() + "\n\n";

            // 2. Identity & Role
            // Check for custom system prompt first - if provided, use it instead of role-based prompts
            if (node.customSystemPrompt) {
                finalPrompt += node.customSystemPrompt + "\n\n";
            } else if (nodeId === run.rootOrchestratorNodeId) {
                finalPrompt += this.promptFactory.buildOrchestratorPrompt() + "\n\n";
            } else {
                finalPrompt += this.promptFactory.buildSubAgentPrompt(node.role ?? "implementer") + "\n\n";
            }

            // 3. Operational Context (Modes & Capabilities)
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
    "role": "implementer",
    "label": "Agent Name",
    "instructions": "Specific instructions for the agent...",
    "input": { ... }
  }
}
\`\`\`
Use this when you need to paralellize work or delegate a specific sub-task.\n\n`;

            finalPrompt += systemPreamble;

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

            // 4. Specific Task / Input Processing
            let taskPrompt = "";
            const initialInstructions = (node.input as any)?.initialInstructions as string | undefined;

            if ((!node.turnCount || node.turnCount === 0) && inputEnvelopes.length === 0) {
                // First turn / Boot checks
                if (initialInstructions) {
                    taskPrompt = `### Specific Instructions\n${initialInstructions}\n\n` + contextBlock;
                } else if (nodeId === run.rootOrchestratorNodeId) {
                    taskPrompt = `### Current Task\n${run.prompt || "Ready for instructions."}\n\n` + contextBlock;
                } else {
                    // Fallback for sub-agents without explicit instructions (shouldn't happen often if spawned correctly)
                    taskPrompt = `### Waiting for Instructions\nWaiting for specific instructions via Handoff.\n` + contextBlock;
                }
            } else if (inputEnvelopes.length > 0) { // Continuation Logic
                // Build prompt from envelopes
                taskPrompt = "Incoming transmissions:\n\n";
                for (const env of inputEnvelopes) {
                    taskPrompt += `--- From Node ${env.fromNodeId} ---\n`;
                    taskPrompt += `${env.payload.message ?? "(No message)"}\n`;
                    if (env.payload.structured) {
                        taskPrompt += `Data: ${JSON.stringify(env.payload.structured, null, 2)}\n`;
                    }
                    if (env.payload.artifacts?.length) {
                        taskPrompt += `Artifacts: ${env.payload.artifacts.map(a => a.ref).join(", ")}\n`;
                    }
                    taskPrompt += "\n";
                }
                taskPrompt += "\nBased on the above inputs, proceed with your task.";
            } else {
                // Tick-based
                const lastOutput = node.output ? JSON.stringify(node.output).slice(0, 500) : "none";

                // If there are chat messages, clarify when to output DONE vs continue conversation
                if (additionalPromptText) {
                    taskPrompt = `Tick (Loop Continuation).\n` +
                        `Global Mode: ${effectiveMode}\n` +
                        `Previous Output: ${lastOutput}\n\n` +
                        `The user has sent you a message. Respond appropriately.\n` +
                        `- If they gave you a task and you have completed it, output { "status": "DONE" }.\n` +
                        `- If you need more information or clarification, ask and wait.`;
                } else {
                    taskPrompt = `Tick (Loop Continuation).\n` +
                        `Global Mode: ${effectiveMode}\n` +
                        `Previous Output: ${lastOutput}\n\n` +
                        `Continue execution. If task is done, output { "status": "DONE" }.`;
                }
            }

            finalPrompt += taskPrompt;

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

            const duration = Date.now() - startTime;
            log.info("Node execution completed", {
                runId,
                nodeId,
                label: node.label,
                durationMs: duration,
                turnCount: node.turnCount,
                stallCount
            });

        } catch (error: unknown) {
            const duration = Date.now() - startTime;
            const err = error instanceof Error ? error : new Error(String(error));

            if (signal.aborted || err.message === "aborted") {
                log.info("Node execution aborted", { runId, nodeId, durationMs: duration });
                this.bus.emitNodePatch(runId, nodeId, { status: "queued" }, "node.progress");
            } else {
                log.error("Node execution failed", {
                    runId,
                    nodeId,
                    error: err.message,
                    durationMs: duration
                });
                this.bus.emitNodePatch(runId, nodeId, { status: "failed", error: { message: err.message } }, "node.failed");
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
        const startTime = Date.now();
        log.info("Executing manual turn", { runId, nodeId, messageLength: userMessage.length });

        const run = this.store.getRun(runId);
        if (!run) {
            log.warn("Manual turn failed: run not found", { runId, nodeId });
            return { success: false, error: "Run not found" };
        }

        const node = run.nodes[nodeId];
        if (!node) {
            log.warn("Manual turn failed: node not found", { runId, nodeId });
            return { success: false, error: "Node not found" };
        }

        // Mark starting
        this.bus.emitNodePatch(runId, nodeId, { status: "running", startedAt: nowIso() }, "node.started");

        try {
            const providerId = node.providerId ?? "mock";
            const provider = this.providers.get(providerId);
            if (!provider) {
                log.error("Manual turn failed: provider not found", { runId, nodeId, providerId });
                throw new Error("Provider not found");
            }

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

            const duration = Date.now() - startTime;
            log.info("Manual turn completed", { runId, nodeId, durationMs: duration, turnNum });
            return { success: true, output };

        } catch (e: unknown) {
            const duration = Date.now() - startTime;
            const err = e instanceof Error ? e : new Error(String(e));
            log.error("Manual turn failed", { runId, nodeId, error: err.message, durationMs: duration });
            this.bus.emitNodePatch(runId, nodeId, { status: "failed", error: { message: err.message } }, "node.failed");
            return { success: false, error: err.message };
        }
    }

    public async runProviderTask(
        runId: string,
        node: NodeRecord,
        provider: ProviderAdapter,
        params: { prompt: string; outputSchemaName?: "plan" | "repo-brief" },
        signal: AbortSignal
    ): Promise<unknown> {
        const startTime = Date.now();
        log.debug("Running provider task", {
            runId,
            nodeId: node.id,
            providerId: provider.id,
            promptLength: params.prompt.length
        });

        const wsPath = await this.workspace.prepareWorkspace({
            repoPath: this.store.getRun(runId)!.repoPath,
            runId,
            nodeId: node.id,
        });
        this.bus.emitNodePatch(runId, node.id, { status: "running", startedAt: nowIso(), workspacePath: wsPath }, "node.started");

        // Session logic
        const existingSession = this.sessionRegistry.getByNodeId(node.id);
        const sessionId = node.providerSessionId ?? existingSession?.providerSessionId;
        log.debug("Provider session", { runId, nodeId: node.id, sessionId: sessionId ?? "new" });

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
                // Only use 'final' event output if we haven't already captured content from 'message.final'
                // This prevents the CLI's cleanup/exit event (which might be an object) from overwriting 
                // the actual agent response text we gathered earlier.
                if (finalOutput === undefined) {
                    finalOutput = ev.output;
                }
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
                log.info("Graph command intercepted from output", {
                    runId,
                    nodeId: node.id,
                    command: cmd.command,
                    label: cmd.args.label
                });
                const result = this.onGraphCommand(runId, node.id, cmd);
                finalOutput += "\n\n" + result;
            }
        }

        // Git Diff Capture
        const diff = this.workspace.captureGitDiff(wsPath);
        if (diff.ok && (diff.diff.trim().length || diff.status.trim().length)) {
            log.debug("Captured git diff", { runId, nodeId: node.id, diffSize: diff.diff.length });
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

        const duration = Date.now() - startTime;
        log.debug("Provider task completed", {
            runId,
            nodeId: node.id,
            durationMs: duration,
            outputType: typeof finalOutput
        });

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
            case "message.reasoning":
                this.bus.emitMessageReasoning(runId, node.id, ev.content);
                break;
            case "message.final":
                this.bus.emitMessageFinal(runId, node.id, ev.content, ev.tokenCount);
                break;
            case "tool.proposed": {
                // Emit tool proposed event for UI visibility
                this.bus.emitToolProposed(runId, node.id, ev.tool);

                // --- SPECIAL HANDLING: Intercept spawn_node ---
                // If the agent uses a native tool call for spawn_node, we intercept it here
                // and execute it as a Graph Command immediately.
                if (ev.tool.name === "spawn_node") {
                    log.info("Intercepting native spawn_node tool call", {
                        runId,
                        nodeId: node.id,
                        toolId: ev.tool.id,
                        label: (ev.tool.args as Record<string, unknown>)?.label
                    });
                    const cmd: GraphCommand = {
                        command: "spawn_node",
                        args: ev.tool.args as GraphCommandSpawn["args"]
                    };
                    const result = this.onGraphCommand(runId, node.id, cmd);

                    // Respond to the tool immediately (simulated success)
                    // We treat this as "auto-approved" because it's a system primitive
                    this.bus.emitToolStarted(runId, node.id, ev.tool.id);
                    this.bus.emitToolCompleted(runId, node.id, ev.tool.id, { result });

                    // We do NOT want to request user approval for this specific tool if intercepted
                    return;
                }
                // ----------------------------------------------

                // Check if CLI permissions are enabled (not skipped)
                const run = this.store.getRun(runId);
                const permissionsEnabled = !(run?.policy?.skipCliPermissions ?? true);

                // When permissions are enabled, request approval and forward response to CLI
                if (permissionsEnabled) {
                    log.debug("Requesting tool approval", {
                        runId,
                        nodeId: node.id,
                        toolName: ev.tool.name,
                        toolId: ev.tool.id
                    });
                    try {
                        const resolution = await this.approvalQueue.requestApproval({
                            runId,
                            nodeId: node.id,
                            tool: ev.tool,
                            context: `Tool: ${ev.tool.name}\nArgs: ${JSON.stringify(ev.tool.args, null, 2)}`,
                        });

                        log.info("Tool approval resolved", {
                            runId,
                            nodeId: node.id,
                            toolName: ev.tool.name,
                            status: resolution.status
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
                    } catch (e) {
                        // Approval request failed or timed out
                        log.warn("Tool approval failed", {
                            runId,
                            nodeId: node.id,
                            toolName: ev.tool.name,
                            error: e instanceof Error ? e.message : String(e)
                        });
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
