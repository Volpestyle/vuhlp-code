
import path from "node:path";
import { DocsIterationPlan, ManualTurnOptions } from "./types.js";

interface PromptFactoryConfig {
    roles: Record<string, string>;
    planning?: { docsDirectory?: string };
}

export class PromptFactory {
    constructor(private cfg: PromptFactoryConfig) { }

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
