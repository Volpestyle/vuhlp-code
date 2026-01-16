import { EventBus } from "./eventBus.js";
import { RunStore } from "./store.js";
import { ProviderRegistry } from "../providers/registry.js";
import { GeminiCliProvider } from "../providers/geminiCli.js";
import { log } from "./logger.js";
import { ProviderTask } from "../providers/types.js";

/**
 * Service that runs a background loop to generate short status summaries
 * for active nodes using a fast, cheap model (Gemini 2.0 Flash).
 */
export class NodeSummarizerService {
    private store: RunStore;
    private bus: EventBus;
    private providers: ProviderRegistry;

    // Set of nodes that have had activity recently and need a summary update
    private dirtyNodes: Set<string> = new Set();

    // Debounce/interval timer
    private intervalId: NodeJS.Timeout | null = null;
    private processing = false;

    // Cache last summary to avoid redundant patches
    private lastSummaries: Map<string, string> = new Map();

    // Sliding window of recent context strings per node
    private nodeContext: Map<string, string[]> = new Map();

    constructor(store: RunStore, bus: EventBus, providers: ProviderRegistry) {
        this.store = store;
        this.bus = bus;
        this.providers = providers;
    }

    public start() {
        if (this.intervalId) return;

        // Listen for activity events
        this.bus.subscribe((event) => {
            // We are interested in any event that describes "Action"
            // We buffer these into a human-readable context trace for the summarizer
            if (!("nodeId" in event) || !event.nodeId) return;

            const compoundId = `${event.runId}:${event.nodeId}`;
            let description: string | null = null;

            switch (event.type) {
                case "message.user":
                    description = `User: ${event.content}`;
                    break;
                case "message.assistant.final":
                    description = `Assistant: ${event.content}`;
                    break;
                case "tool.proposed":
                    description = `Proposed tool: ${event.tool.name}`;
                    break;
                case "tool.started":
                    // We might not have name here easily without lookup, but acceptable
                    description = `Started executing tool ${event.toolId}`;
                    break;
                case "tool.completed":
                    description = `Finished tool ${event.toolId}`;
                    if (event.error) description += ` (Error: ${event.error.message})`;
                    break;
                case "verification.completed":
                    description = `Verification completed (Success: ${event.report.ok})`;
                    break;
            }

            if (description) {
                this.addContext(compoundId, description);

                // Mark dirty mainly on "start/end" type events or significant messages
                // We don't want to re-summarize strictly on every small thing, but these are all significant.
                const run = this.store.getRun(event.runId);
                const node = run?.nodes[event.nodeId as string]; // cast safe due to check above
                if (node && node.status === 'running') {
                    this.dirtyNodes.add(compoundId);
                }
            }
        });

        // Run processing loop every 3 seconds - slightly relaxed
        this.intervalId = setInterval(() => this.processDirtyNodes(), 3000);
        log.info("NodeSummarizerService started");
    }

    public stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    private addContext(compoundId: string, text: string) {
        const history = this.nodeContext.get(compoundId) ?? [];
        history.push(text);
        // Keep last 6 lines
        if (history.length > 6) history.shift();
        this.nodeContext.set(compoundId, history);
    }

    private async processDirtyNodes() {
        if (this.processing || this.dirtyNodes.size === 0) return;
        this.processing = true;

        try {
            const nodesToProcess = Array.from(this.dirtyNodes);
            this.dirtyNodes.clear();
            await Promise.all(nodesToProcess.map(id => this.summarizeNode(id)));
        } catch (e) {
            log.error("Error in summarizer loop", { error: e });
        } finally {
            this.processing = false;
        }
    }

    private async summarizeNode(compoundId: string) {
        const history = this.nodeContext.get(compoundId);
        if (!history || history.length === 0) return;

        // 2. Prepare Prompt
        // Join last few lines
        const contextText = history.join("\n");

        const [runId, nodeId] = compoundId.split(":");
        const run = this.store.getRun(runId);
        const node = run?.nodes[nodeId];
        if (!node || node.status !== 'running') return;

        // 2. Prepare Prompt (continued)
        const systemPrompt = `You are a background monitoring process. 
Summarize the agent's CURRENT STATUS in 3-6 words.
Examples: "Running unit tests", "Debugging API error", "Waiting for user input".
Be extremely concise. Use active verbs.`;

        // 3. Call Gemini Flash
        const provider = this.getGeminiProvider();
        if (!provider) return;

        try {
            const result = await this.generateSummary(provider, systemPrompt, contextText);
            if (result) {
                if (this.lastSummaries.get(compoundId) !== result) {
                    this.lastSummaries.set(compoundId, result);

                    node.summary = result;
                    // Optimistic patch for UI
                    this.bus.emitNodePatch(runId, nodeId, { summary: result }, "node.progress");
                    // Optionally persist?
                    // this.store.persistRun(run); 
                    // Persisting every 3s might be heavy. Let's trust eventual consistency or periodic save.
                    // But "summary" is persistent field.
                    this.store.persistRun(run);
                }
            }
        } catch (e) {
            log.warn("Failed to generate summary", { nodeId, error: String(e) });
        }
    }



    private getGeminiProvider(): GeminiCliProvider | null {
        const all = this.providers.list();
        const gemini = all.find(p => p.kind === 'gemini-cli');
        return (gemini as GeminiCliProvider) || null;
    }
    private async generateSummary(
        provider: GeminiCliProvider,
        systemPrompt: string,
        userContext: string
    ): Promise<string | null> {

        // Create correct ProviderTask
        const task: ProviderTask = {
            runId: "system",
            nodeId: "system",
            role: "investigator", // arbitrary valid role
            prompt: `${systemPrompt}\n\nCONTEXT:\n${userContext}`,
            workspacePath: "/tmp",
            skipPermissions: true,
            // Attempt to force model via meta?
            meta: { model: "gemini-2.0-flash-exp" }
        };

        const signal = AbortSignal.timeout(5000); // 5s timeout
        let fullOutput = "";

        try {
            for await (const event of provider.runTask(task, signal)) {
                if (event.type === 'message.delta') {
                    fullOutput += event.delta;
                } else if (event.type === 'message.final') {
                    fullOutput = event.content;
                    break; // Optimization
                }
            }

            let summary = fullOutput.trim();
            summary = summary.replace(/^["']|["']$/g, ''); // remove quotes
            summary = summary.replace(/\.$/, ''); // remove trailing dot

            return summary;
        } catch (e) {
            return null;
        }
    }
}
