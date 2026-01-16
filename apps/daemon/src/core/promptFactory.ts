
import path from "node:path";
import fs from "node:fs";
import { DocsIterationPlan, ManualTurnOptions } from "./types.js";

interface PromptFactoryConfig {
    roles: Record<string, string>;
    planning?: { docsDirectory?: string };
}

export class PromptFactory {
    constructor(private cfg: PromptFactoryConfig) { }

    private loadedPrompts: Record<string, string> = {};

    /**
     * Load prompts from docs/prompts.md if available.
     */
    loadFromDocs(repoPath: string): void {
        const docsDir = this.cfg.planning?.docsDirectory ?? "docs";
        const promptsPath = path.join(repoPath, docsDir, "prompts.md");

        if (fs.existsSync(promptsPath)) {
            try {
                const content = fs.readFileSync(promptsPath, "utf-8");
                this.loadedPrompts = this.parsePromptsFromMarkdown(content);
            } catch (e) {
                console.error("Failed to load prompts from docs:", e);
            }
        }
    }

    private parsePromptsFromMarkdown(content: string): Record<string, string> {
        const sections: Record<string, string> = {};
        const lines = content.split("\n");
        let currentSection: string | null = null;
        let buf: string[] = [];

        for (const line of lines) {
            // Match H2 headers like "## 1. System Specification (Context)"
            // We'll key them by a simplified normalized string or just the full header
            const match = line.match(/^##\s+(.*)$/);
            if (match) {
                if (currentSection) {
                    sections[currentSection] = buf.join("\n").trim();
                }
                currentSection = match[1].trim();
                buf = [line]; // Include the header in the content
            } else if (currentSection) {
                buf.push(line);
            }
        }
        if (currentSection) {
            sections[currentSection] = buf.join("\n").trim();
        }
        return sections;
    }

    /**
     * Build system context (Architectural Vision).
     */
    buildSystemContext(): string {
        // Try to find matching section
        const key = Object.keys(this.loadedPrompts).find(k => k.includes("System Specification"));
        if (key && this.loadedPrompts[key]) return this.loadedPrompts[key];

        return [
            "## 1. System Specification (Context)",
            "",
            "> **Usage**: Inject this into the `Root Orchestrator` or any agent requiring high-level understanding of the system's architectural vision.",
            "",
            "### Core Philosophy: \"Flexible Orchestration\"",
            "- **Beyond the Fixed Loop**: The system is not a rigid pipeline (Plan -> Code -> Test). It is a flexible graph of autonomous nodes.",
            "- **Graph as Configuration**: The execution logic is defined by the graph topology. Users \"build\" their orchestration by connecting windows (nodes) in the UI.",
            "- **Roles as Templates**:",
            "    - \"Roles\" (e.g., Orchestrator, Implementer, Verifier) are simply preset configurations of instructions and tools.",
            "    - **Default Behavior**: A generic node behaves as a standard CLI session.",
            "    - **Orchestrator Role**: Specialized by the ability to spawn sub-agents and manage delegation.",
            "",
            "### Execution Modes",
            "1.  **Global Modes**:",
            "    - **PLANNING (Docs-First)**:",
            "        - *Focus*: Analysis, design, and documentation.",
            "        - *Constraint*: Agents verify plans and write ONLY to the `/docs/` directory.",
            "        - *Behavior*: Sub-agents report findings; Orchestrator reconciles. No direct code implementation.",
            "    - **IMPLEMENTATION (Default)**:",
            "        - *Focus*: Building and verifying.",
            "        - *Constraint*: Agents have full write access to the codebase.",
            "        - *Behavior*: Orchestrator delegates tasks; Sub-agents apply changes; Orchestrator reviews.",
            "",
            "2.  **Node Modes**:",
            "    - **INTERACTIVE**: The node pauses for user input after every turn.",
            "    - **AUTO**: The node loops autonomously. It re-consumes its initial prompt or processes incoming inputs until its objective is met.",
            "        - *Looping Logic*: Output of one node (e.g., Planner) feeds into another (e.g., Coder), creating a feedback loop until verification passes.",
        ].join("\n");
    }

    /**
     * Build the primary Orchestrator prompt.
     */
    buildOrchestratorPrompt(): string {
        const key = Object.keys(this.loadedPrompts).find(k => k.includes("Orchestrator Prompt"));
        if (key && this.loadedPrompts[key]) return this.loadedPrompts[key];

        return [
            "## 2. The Orchestrator Prompt",
            "",
            "> **Usage**: The primary system instruction for the Root Orchestrator node.",
            "",
            "### Identity",
            "- **You are a Technical Lead**, in full command of a team of agents.",
            "- **Authority**: You dictate the flow of work. You may choose to have agents work on parallel tasks or separate their domains methodically.",
            "",
            "### Core Directive: \"Work in Harmony\"",
            "- Agents are designed to work in harmony when directed by you.",
            "- **Delegation is Power**: You should spawn an agent anytime doing so would improve productivity and speed.",
            "",
            "### How to Direct Agents",
            "When spawning a sub-agent, you must provide:",
            "1.  **Necessary Context**: The facts and files required to do the job.",
            "2.  **Clear Goal**: A specific checklist or objective.",
            "3.  **Definition of Done**: A clear standard for evaluating their work.",
            "",
            "### Universal Rule",
            "- **Always reference docs**. Never stray from the docs. Always keep them up to date and cross-examine gaps or misalignments.",
            "",
            "### Follow-Up & Review",
            "- **Trust but Verify**: You should trust your agents, but challenge them.",
            "- **Evaluation**:",
            "    - Was the desired objective accomplished?",
            "    - Is the implementation actually complete, or did they just say it was?",
            "    - Evaluate their reasoning against documented plans.",
            "- **Correction**: If you deem necessary, **correct them yourself** or tell them to redo/undo work.",
        ].join("\n");
    }

    /**
     * Build the Sub-agent prompt.
     */
    buildSubAgentPrompt(role: string): string {
        const key = Object.keys(this.loadedPrompts).find(k => k.includes("Subagent Prompt"));
        if (key && this.loadedPrompts[key]) {
            let text = this.loadedPrompts[key];
            if (text.includes("You are a Specialist Agent")) {
                text = text.replace("You are a Specialist Agent", `You are a Specialist Agent (Role: ${role})`);
            }
            return text;
        }

        return [
            "## 3. The Subagent Prompt",
            "",
            "> **Usage**: Inject this into any node spawned by an Orchestrator.",
            "",
            "### Identity & mission",
            `- **You are a Specialist Agent** spawned for a specific task (Role: ${role}).`,
            "- **Directive**: Evaluate your context and **fully complete the todo list** given to you by the Orchestrator.",
            "",
            "### Parallelism & Conflict",
            "- You are likely working in parallel with other agents.",
            "- **Work in Harmony**: You may see changes happening in the file you're working in or around—they may even do something you were about to do. This is expected.",
            "- **Adapt**: If you see a change, assume it is valid and work around it or build upon it. Do not undo others' work unless explicitly instructed.",
        ].join("\n");
    }

    /**
     * Build prompt for doc drafting agent.
     */
    buildDocDraftPrompt(task: DocsIterationPlan["docAgentTasks"][0]): string {
        return [
            "You are a documentation agent inside vuhlp code.",
            "",
            `Role: ${task.role}`,
            "",
            `Your task: Create the file ${task.targetDoc}`,
            "",
            "Instructions:",
            task.instructions,
            "",
            "Requirements:",
            "- Write clear, concise markdown documentation.",
            "- Use proper markdown formatting with headers, lists, and code blocks where appropriate.",
            "- Focus on practical, actionable content.",
            "- Save the file to the specified path.",
        ].join("\n");
    }

    /**
     * Build prompt for doc review agent.
     */
    buildDocReviewPrompt(run: { prompt: string; repoPath: string }): string {
        return [
            "You are a documentation reviewer agent inside vuhlp code.",
            "",
            "Review all generated documentation for consistency, completeness, and alignment with the project goals.",
            "",
            `Project goal: ${run.prompt}`,
            `Repo path: ${run.repoPath}`,
            "",
            "Check for:",
            "- Contradictions between documents",
            "- Missing critical information",
            "- Unclear or ambiguous sections",
            "- Alignment with project goals",
            "",
            "Return JSON with fields: approved (boolean), contradictions (array of {doc, issue}), suggestions (array).",
        ].join("\n");
    }

    /**
     * Build prompt for docs sync agent.
     */
    buildDocsSyncPrompt(run: { prompt: string; repoPath: string }, changes: { filesChanged: string[]; summary: string }): string {
        return [
            "You are a documentation sync agent inside vuhlp code.",
            "",
            "Update the project documentation to reflect the changes made in this implementation run.",
            "",
            `Original request: ${run.prompt}`,
            `Repo path: ${run.repoPath}`,
            "",
            "Files changed:",
            changes.filesChanged.map((f) => `- ${f}`).join("\n"),
            "",
            "Changes summary:",
            changes.summary.slice(0, 3000),
            "",
            "Tasks:",
            "1. Update docs/ARCHITECTURE.md if architecture changed",
            "2. Update docs/DECISIONS.md with any new decisions made",
            "3. Update other relevant documentation",
            "",
            "Only update docs if there are meaningful changes to document.",
            "Do not create new files unless necessary.",
        ].join("\n");
    }

    /**
     * Build prompt for changelog update.
     */
    buildChangelogPrompt(run: { prompt: string }, changes: { filesChanged: string[]; summary: string }): string {
        return [
            "You are a changelog agent inside vuhlp code.",
            "",
            "Append an entry to docs/CHANGELOG.md (create if it doesn't exist) for this implementation run.",
            "",
            `Implementation: ${run.prompt}`,
            "",
            "Files changed:",
            changes.filesChanged.slice(0, 20).map((f) => `- ${f}`).join("\n"),
            "",
            "Format:",
            "```markdown",
            "## [Date] - Brief Description",
            "",
            "### Added/Changed/Fixed",
            "- Description of changes",
            "```",
            "",
            "Keep the entry concise but informative.",
        ].join("\n");
    }

    /**
     * Build prompt for final doc review.
     */
    buildFinalDocReviewPrompt(run: { prompt: string; repoPath: string }): string {
        return [
            "You are a final documentation reviewer inside vuhlp code.",
            "",
            "Perform a final review of all documentation to ensure:",
            "1. Consistency between implementation and documentation",
            "2. No contradictions between different docs",
            "3. All major changes are documented",
            "",
            `Project goal: ${run.prompt}`,
            `Repo path: ${run.repoPath}`,
            "",
            "Read the docs directory and verify alignment.",
            "",
            "Return JSON: { reviewed: true, issues: [], notes: string }",
        ].join("\n");
    }

    /**
     * Build prompt for manual turn.
     * Note: This method consumes pending messages logic from Orchestrator externally before calling this,
     * or we pass the chatSection string. To keep it pure, we'll pass the chatSection string.
     */
    buildManualTurnPrompt(
        userMessage: string,
        chatSection?: string,
        options?: ManualTurnOptions
    ): string {
        let prompt = userMessage;

        // Add context if specified
        if (options?.attachContext?.length) {
            prompt += "\n\n--- ATTACHED CONTEXT ---\n";
            for (const ctx of options.attachContext) {
                prompt += `\n${ctx}\n`;
            }
            prompt += "--- END CONTEXT ---\n";
        }

        if (chatSection) {
            prompt += "\n" + chatSection;
        }

        return prompt;
    }
}
