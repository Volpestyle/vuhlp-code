import fs from "node:fs";
import path from "node:path";
import { ContextPack, RepoFacts, RunRecord, TaskStep } from "./types.js";

/**
 * Context Pack Builder - Section 5.3.3 of implementation_alignment.md
 *
 * Generates curated working sets for agent prompts:
 * - Minimal, relevant context per node
 * - Doc excerpts based on task anchors
 * - Prior results from completed nodes
 * - Constraints and output schema
 */
export class ContextPackBuilder {
  /**
   * Build a context pack for a task step.
   */
  buildForStep(params: {
    run: RunRecord;
    step: TaskStep;
    repoPath: string;
    relevantFiles?: Array<{ path: string; summary?: string }>;
    constraints?: ContextPack["constraints"];
    outputSchema?: string;
  }): ContextPack {
    const { run, step, repoPath, relevantFiles, constraints, outputSchema } = params;

    // Collect prior results from completed nodes
    const priorResults = this.collectPriorResults(run, step);

    // Find relevant docs based on step
    const docsSourceOfTruth = this.findRelevantDocs(repoPath, step);

    return {
      taskId: step.id,
      goal: step.title,
      docsSourceOfTruth,
      repoFacts: run.repoFacts ? this.compactRepoFacts(run.repoFacts) : undefined,
      relevantFiles: relevantFiles ?? [],
      priorResults,
      constraints: constraints ?? {
        mustUpdateDocsOnBehaviorChange: true,
      },
      outputSchema,
    };
  }

  /**
   * Build a context pack for investigation phase.
   */
  buildForInvestigation(params: {
    run: RunRecord;
    repoPath: string;
  }): ContextPack {
    const { run } = params;
    return {
      taskId: "investigate",
      goal: "Understand the repository structure, detect languages, and identify verification commands",
      repoFacts: run.repoFacts ? this.compactRepoFacts(run.repoFacts) : undefined,
      constraints: {
        noNewDependencies: true,
      },
    };
  }

  /**
   * Build a context pack for planning phase.
   */
  buildForPlanning(params: {
    run: RunRecord;
    repoPath: string;
    userPrompt: string;
    investigationSummary?: string;
  }): ContextPack {
    const { run, userPrompt, investigationSummary } = params;

    return {
      taskId: "plan",
      goal: `Create a task DAG to satisfy: ${userPrompt}`,
      repoFacts: run.repoFacts ? this.compactRepoFacts(run.repoFacts) : undefined,
      priorResults: investigationSummary
        ? [{ from: "investigator", summary: investigationSummary }]
        : undefined,
      constraints: {
        mustUpdateDocsOnBehaviorChange: true,
      },
      outputSchema: JSON.stringify({
        taskDag: {
          summary: "string",
          steps: [
            {
              id: "string",
              title: "string",
              instructions: "string",
              deps: ["string (step ids)"],
              agentHint: "string"
            }
          ]
        },
        acceptanceCriteria: [
          {
            id: "string",
            description: "string",
            checkType: "test | lint | build | manual | custom",
            checkCommand: "string?"
          }
        ]
      }, null, 2)
    };
  }

  /**
   * Collect prior results from completed nodes that this step depends on.
   */
  private collectPriorResults(
    run: RunRecord,
    step: TaskStep
  ): Array<{ from: string; artifact?: string; summary?: string }> {
    const results: Array<{ from: string; artifact?: string; summary?: string }> = [];

    // Get dependent step IDs
    const deps = step.deps ?? [];
    if (!deps.length) return results;

    // Find nodes for those steps and collect their summaries
    for (const dep of deps) {
      // Find the step with this ID
      const depStep = run.taskDag?.steps.find((s) => s.id === dep);
      if (!depStep?.nodeId) continue;

      const depNode = run.nodes[depStep.nodeId];
      if (!depNode || depNode.status !== "completed") continue;

      results.push({
        from: `${depNode.role ?? "agent"}:${depNode.providerId ?? "unknown"}#${depNode.id.slice(0, 8)}`,
        summary: depNode.summary,
      });

      // Find any artifacts from this node
      const nodeArtifacts = Object.values(run.artifacts).filter(
        (a) => a.nodeId === depNode.id
      );
      if (nodeArtifacts.length > 0) {
        results[results.length - 1].artifact = nodeArtifacts[0].id;
      }
    }

    return results;
  }

  /**
   * Find relevant docs based on step instructions/title.
   */
  private findRelevantDocs(
    repoPath: string,
    step: TaskStep
  ): Array<{ path: string; anchors?: string[] }> {
    const docs: Array<{ path: string; anchors?: string[] }> = [];
    const docsDir = path.join(repoPath, "docs");

    if (!fs.existsSync(docsDir)) return docs;

    // Check for common doc files
    const docFiles = [
      "OVERVIEW.md",
      "ARCHITECTURE.md",
      "PLAN.md",
      "ACCEPTANCE.md",
      "DECISIONS.md",
      "README.md",
    ];

    for (const file of docFiles) {
      const filePath = path.join(docsDir, file);
      if (fs.existsSync(filePath)) {
        // For now, include all docs without specific anchors
        // A more advanced implementation would parse the step instructions
        // and find relevant sections
        docs.push({ path: `/docs/${file}` });
      }
    }

    return docs;
  }

  /**
   * Create a compact version of repo facts for context pack.
   */
  private compactRepoFacts(facts: RepoFacts): Partial<RepoFacts> {
    return {
      language: facts.language,
      languages: facts.languages,
      entrypoints: facts.entrypoints?.slice(0, 5),
      testCommands: facts.testCommands?.slice(0, 3),
      hasTests: facts.hasTests,
      hasDocs: facts.hasDocs,
      hasOnlyDocs: facts.hasOnlyDocs,
      hasCode: facts.hasCode,
      packageManager: facts.packageManager,
    };
  }

  /**
   * Serialize context pack to a prompt section.
   */
  toPromptSection(pack: ContextPack): string {
    const lines: string[] = [];

    lines.push("--- CONTEXT PACK ---");
    lines.push(`Task ID: ${pack.taskId}`);
    lines.push(`Goal: ${pack.goal}`);

    if (pack.docsSourceOfTruth?.length) {
      lines.push("");
      lines.push("Docs (source of truth):");
      for (const doc of pack.docsSourceOfTruth) {
        const anchors = doc.anchors?.length ? ` [anchors: ${doc.anchors.join(", ")}]` : "";
        lines.push(`  - ${doc.path}${anchors}`);
      }
    }

    if (pack.repoFacts) {
      lines.push("");
      lines.push("Repo facts:");
      lines.push(`  Language: ${pack.repoFacts.language}`);
      if (pack.repoFacts.entrypoints?.length) {
        lines.push(`  Entrypoints: ${pack.repoFacts.entrypoints.join(", ")}`);
      }
      if (pack.repoFacts.testCommands?.length) {
        lines.push(`  Test commands: ${pack.repoFacts.testCommands.join(", ")}`);
      }
    }

    if (pack.relevantFiles?.length) {
      lines.push("");
      lines.push("Relevant files:");
      for (const file of pack.relevantFiles) {
        const summary = file.summary ? ` - ${file.summary}` : "";
        lines.push(`  - ${file.path}${summary}`);
      }
    }

    if (pack.priorResults?.length) {
      lines.push("");
      lines.push("Prior results:");
      for (const result of pack.priorResults) {
        const summary = result.summary ? `: ${result.summary}` : "";
        lines.push(`  - From ${result.from}${summary}`);
      }
    }

    if (pack.constraints) {
      lines.push("");
      lines.push("Constraints:");
      if (pack.constraints.noNewDependencies) {
        lines.push("  - No new dependencies allowed");
      }
      if (pack.constraints.mustUpdateDocsOnBehaviorChange) {
        lines.push("  - Must update docs if behavior changes");
      }
      if (pack.constraints.allowedTools?.length) {
        lines.push(`  - Allowed tools: ${pack.constraints.allowedTools.join(", ")}`);
      }
    }

    lines.push("--- END CONTEXT PACK ---");

    return lines.join("\n");
  }
}
