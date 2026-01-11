import { randomUUID } from "node:crypto";
import path from "node:path";
import { EventBus } from "./eventBus.js";
import { RunStore } from "./store.js";
import { nowIso } from "./time.js";
import { NodeRecord, EdgeRecord, RoleId } from "./types.js";
import { ProviderRegistry } from "../providers/registry.js";
import { ProviderAdapter } from "../providers/types.js";
import { WorkspaceManager } from "./workspace.js";
import { Semaphore } from "./scheduler.js";
import { verifyAll } from "./verifier.js";
import fs from "node:fs";

export interface OrchestratorConfig {
  roles: Record<string, string>;
  scheduler: { maxConcurrency: number };
  orchestration: { maxIterations: number };
  verification: { commands: string[] };
}

export interface CreateRunParams {
  prompt: string;
  repoPath: string;
  configSnapshot: Record<string, unknown>;
}

export class OrchestratorEngine {
  private store: RunStore;
  private bus: EventBus;
  private providers: ProviderRegistry;
  private workspace: WorkspaceManager;
  private cfg: OrchestratorConfig;

  // active runs
  private controllers: Map<string, AbortController> = new Map();

  constructor(params: {
    store: RunStore;
    bus: EventBus;
    providers: ProviderRegistry;
    workspace: WorkspaceManager;
    cfg: OrchestratorConfig;
  }) {
    this.store = params.store;
    this.bus = params.bus;
    this.providers = params.providers;
    this.workspace = params.workspace;
    this.cfg = params.cfg;
  }

  isRunning(runId: string): boolean {
    return this.controllers.has(runId);
  }

  stopRun(runId: string): boolean {
    const c = this.controllers.get(runId);
    if (!c) return false;
    c.abort();
    return true;
  }

  async startRun(runId: string): Promise<void> {
    if (this.controllers.has(runId)) return;
    const controller = new AbortController();
    this.controllers.set(runId, controller);

    try {
      await this.runLoop(runId, controller.signal);
    } finally {
      this.controllers.delete(runId);
    }
  }

  private roleProvider(role: RoleId): ProviderAdapter {
    const providerId = this.cfg.roles[role] ?? "mock";
    const p = this.providers.get(providerId);
    if (!p) throw new Error(`Provider not configured: ${providerId} (role=${role})`);
    return p;
  }

  private async runLoop(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const rootNodeId = run.rootOrchestratorNodeId;

    this.bus.emitRunPatch(runId, { id: runId, status: "running" }, "run.started");
    this.bus.emitNodePatch(runId, rootNodeId, { status: "running", startedAt: nowIso() }, "node.started");

    // Root orchestrator workspace (mostly used for verification).
    const rootWs = await this.workspace.prepareWorkspace({ repoPath: run.repoPath, runId, nodeId: rootNodeId });
    this.bus.emitNodePatch(runId, rootNodeId, { workspacePath: rootWs }, "node.progress");

    let iteration = 0;
    let plan: any = null;
    let lastVerificationLog = "";

    while (!signal.aborted) {
      if (iteration >= run.maxIterations) {
        this.bus.emitNodeProgress(runId, rootNodeId, `Max iterations reached (${run.maxIterations}). Failing run.`);
        this.bus.emitRunPatch(runId, { id: runId, status: "failed" }, "run.failed");
        this.bus.emitNodePatch(runId, rootNodeId, { status: "failed", completedAt: nowIso() }, "node.failed");
        return;
      }

      // INVESTIGATE (only on iteration 0)
      if (iteration === 0) {
        const invNode = this.createTaskNode({
          runId,
          parentNodeId: rootNodeId,
          label: "Investigate",
          role: "investigator",
          providerId: this.cfg.roles["investigator"] ?? "mock",
        });
        this.createEdge(runId, rootNodeId, invNode.id, "handoff", "investigate");
        await this.runProviderNode(invNode, this.roleProvider("investigator"), {
          prompt: this.buildInvestigationPrompt(run.prompt, run.repoPath),
          outputSchemaName: "repo-brief",
        }, signal);
        this.createEdge(runId, invNode.id, rootNodeId, "report", "investigation report");
      }

      // PLAN (only on iteration 0 for v0)
      if (iteration === 0) {
        const planNode = this.createTaskNode({
          runId,
          parentNodeId: rootNodeId,
          label: "Plan",
          role: "planner",
          providerId: this.cfg.roles["planner"] ?? "mock",
        });
        this.createEdge(runId, rootNodeId, planNode.id, "handoff", "plan");
        plan = await this.runProviderNode(planNode, this.roleProvider("planner"), {
          prompt: this.buildPlanningPrompt(run.prompt, lastVerificationLog),
          outputSchemaName: "plan",
        }, signal);
        this.createEdge(runId, planNode.id, rootNodeId, "report", "plan report");
      }

      // IMPLEMENT steps
      const steps = this.extractSteps(plan, run.prompt, iteration, lastVerificationLog);
      const semaphore = new Semaphore(this.cfg.scheduler.maxConcurrency);

      // Map stepId -> nodeId
      const stepNodes: Array<{ step: any; node: NodeRecord }> = [];
      for (const step of steps) {
        const providerId = this.pickProviderForStep(step);
        const node = this.createTaskNode({
          runId,
          parentNodeId: rootNodeId,
          label: step.title ?? step.id ?? "Step",
          role: "implementer",
          providerId,
          input: { step },
        });
        stepNodes.push({ step, node });
        this.createEdge(runId, rootNodeId, node.id, "handoff", "step");
      }

      // dependencies edges
      const byStepId = new Map<string, string>();
      for (const sn of stepNodes) {
        if (sn.step.id) byStepId.set(String(sn.step.id), sn.node.id);
      }
      for (const sn of stepNodes) {
        const deps: string[] = Array.isArray(sn.step.deps) ? sn.step.deps : [];
        for (const dep of deps) {
          const depNodeId = byStepId.get(dep);
          if (depNodeId) this.createEdge(runId, depNodeId, sn.node.id, "dependency", "depends on");
        }
      }

      // Execute DAG-ish
      const completed = new Set<string>();
      const running = new Map<string, Promise<void>>();

      const startStep = async (sn: { step: any; node: NodeRecord }) => {
        const release = await semaphore.acquire();
        try {
          const provider = this.providers.get(sn.node.providerId ?? "mock") ?? this.roleProvider("implementer");
          const stepPrompt = this.buildStepPrompt(run.prompt, sn.step, iteration, lastVerificationLog);
          await this.runProviderNode(sn.node, provider, { prompt: stepPrompt }, signal);
          this.createEdge(runId, sn.node.id, rootNodeId, "report", "step report");
        } finally {
          release();
          completed.add(sn.node.id);
        }
      };

      const canRun = (sn: { step: any; node: NodeRecord }) => {
        const deps: string[] = Array.isArray(sn.step.deps) ? sn.step.deps : [];
        for (const dep of deps) {
          const depNodeId = byStepId.get(dep);
          if (depNodeId && !completed.has(depNodeId)) return false;
        }
        return true;
      };

      // Main scheduling loop
      while (completed.size < stepNodes.length) {
        if (signal.aborted) throw new Error("Run aborted");
        // launch ready steps
        for (const sn of stepNodes) {
          if (completed.has(sn.node.id)) continue;
          if (running.has(sn.node.id)) continue;
          if (!canRun(sn)) continue;
          const p = startStep(sn).catch((e) => {
            // mark node failed
            this.bus.emitNodePatch(runId, sn.node.id, {
              status: "failed",
              completedAt: nowIso(),
              error: { message: e?.message ?? String(e), stack: e?.stack },
            }, "node.failed");
          });
          running.set(sn.node.id, p);
        }

        // await something to finish
        if (running.size === 0) {
          // Deadlock: deps cycle or missing dep
          this.bus.emitNodeProgress(runId, rootNodeId, "Deadlock in step scheduling. Check plan deps.");
          break;
        }
        await Promise.race([...running.values()]);
        // cleanup resolved
        for (const [nodeId, p] of [...running.entries()]) {
          if (completed.has(nodeId)) running.delete(nodeId);
          else {
            // If promise resolved but didn't mark completed (unlikely), still delete
            // Not robust, but acceptable for v0.
          }
        }
      }

      // REVIEW (optional) - minimal in v0
      const reviewerId = this.cfg.roles["reviewer"];
      if (reviewerId) {
        const reviewNode = this.createTaskNode({
          runId,
          parentNodeId: rootNodeId,
          label: "Review",
          role: "reviewer",
          providerId: reviewerId,
        });
        this.createEdge(runId, rootNodeId, reviewNode.id, "handoff", "review");
        await this.runProviderNode(reviewNode, this.roleProvider("reviewer"), {
          prompt: this.buildReviewPrompt(run.prompt),
        }, signal);
        this.createEdge(runId, reviewNode.id, rootNodeId, "report", "review report");
      }

      // VERIFY
      const verifyNode = this.createVerificationNode(runId, rootNodeId, rootWs);
      this.createEdge(runId, rootNodeId, verifyNode.id, "gate", "verify");

      const verifyOk = await this.runVerificationNode(verifyNode, signal);

      if (verifyOk) {
        this.bus.emitNodePatch(runId, rootNodeId, { status: "completed", completedAt: nowIso() }, "node.completed");
        this.bus.emitRunPatch(runId, { id: runId, status: "completed", iterations: iteration + 1 }, "run.completed");
        return;
      } else {
        // collect last verify logs for fix prompt
        lastVerificationLog = this.collectLatestVerificationLog(runId, verifyNode.id);
        iteration++;
        this.bus.emitRunPatch(runId, { id: runId, iterations: iteration }, "run.updated");
        // In v0, we do not re-plan; we just run a single fix step next iteration.
        plan = {
          summary: "auto-fix (v0)",
          steps: [
            {
              id: `fix-${iteration}`,
              title: `Fix verification failures (iteration ${iteration})`,
              instructions: "Fix the verification failures described in the logs.",
              agentHint: "any",
              deps: [],
            },
          ],
        };
      }
    }

    // aborted
    this.bus.emitRunPatch(runId, { id: runId, status: "stopped" }, "run.stopped");
    this.bus.emitNodePatch(runId, rootNodeId, { status: "skipped", completedAt: nowIso() }, "node.completed");
  }

  private createTaskNode(params: {
    runId: string;
    parentNodeId: string;
    label: string;
    role: RoleId;
    providerId: string;
    input?: unknown;
  }): NodeRecord {
    const id = randomUUID();
    const node: NodeRecord = {
      id,
      runId: params.runId,
      parentNodeId: params.parentNodeId,
      type: "task",
      label: params.label,
      role: params.role,
      providerId: params.providerId,
      status: "queued",
      createdAt: nowIso(),
      input: params.input,
    };
    this.bus.emitNodePatch(params.runId, id, node as any, "node.created");
    return node;
  }

  private createVerificationNode(runId: string, parentNodeId: string, workspacePath: string): NodeRecord {
    const id = randomUUID();
    const node: NodeRecord = {
      id,
      runId,
      parentNodeId,
      type: "verification",
      label: "Verify",
      status: "queued",
      createdAt: nowIso(),
      workspacePath,
    };
    this.bus.emitNodePatch(runId, id, node as any, "node.created");
    return node;
  }

  private createEdge(runId: string, from: string, to: string, type: EdgeRecord["type"], label?: string): void {
    const edge: EdgeRecord = {
      id: randomUUID(),
      runId,
      from,
      to,
      type,
      label,
      createdAt: nowIso(),
    };
    this.bus.emitEdge(runId, edge);
  }

  private pickProviderForStep(step: any): string {
    const hint = (step?.agentHint ?? "any") as string;
    if (hint && hint !== "any") return hint;
    // default implementer role provider
    return this.cfg.roles["implementer"] ?? "mock";
  }

  private schemaJson(name: "plan" | "repo-brief"): string | undefined {
    try {
      const schemaPath = path.resolve(process.cwd(), "..", "..", "docs", "schemas", `${name}.schema.json`);
      if (fs.existsSync(schemaPath)) return fs.readFileSync(schemaPath, "utf-8");
    } catch {
      // ignore
    }
    return undefined;
  }

  private async runProviderNode(
    node: NodeRecord,
    provider: ProviderAdapter,
    params: { prompt: string; outputSchemaName?: "plan" | "repo-brief" },
    signal: AbortSignal
  ): Promise<unknown> {
    const runId = node.runId;
    const wsPath = await this.workspace.prepareWorkspace({
      repoPath: this.store.getRun(runId)!.repoPath,
      runId,
      nodeId: node.id,
    });
    this.bus.emitNodePatch(runId, node.id, { status: "running", startedAt: nowIso(), workspacePath: wsPath }, "node.started");

    const schemaJson = params.outputSchemaName ? this.schemaJson(params.outputSchemaName) : undefined;

    let finalOutput: unknown = undefined;
    let finalSummary: string | undefined = undefined;

    try {
      const iter = provider.runTask(
        {
          runId,
          nodeId: node.id,
          role: (node.role ?? "implementer") as any,
          prompt: params.prompt,
          workspacePath: wsPath,
          outputSchemaJson: schemaJson,
        },
        signal
      );

      for await (const ev of iter) {
        if (signal.aborted) throw new Error("aborted");
        switch (ev.type) {
          case "progress":
            this.bus.emitNodeProgress(runId, node.id, ev.message, ev.raw);
            break;
          case "log": {
            const art = this.store.createArtifact({
              runId,
              nodeId: node.id,
              kind: "log",
              name: ev.name,
              mimeType: "text/plain",
              content: ev.content,
            });
            this.bus.emitArtifact(runId, art);
            break;
          }
          case "json": {
            const art = this.store.createArtifact({
              runId,
              nodeId: node.id,
              kind: "json",
              name: ev.name,
              mimeType: "application/json",
              content: JSON.stringify(ev.json, null, 2),
            });
            this.bus.emitArtifact(runId, art);
            // best-effort: treat named plan outputs as finalOutput
            if (String(ev.name).includes("plan")) finalOutput = ev.json;
            break;
          }
          case "diff": {
            const art = this.store.createArtifact({
              runId,
              nodeId: node.id,
              kind: "diff",
              name: ev.name,
              mimeType: "text/plain",
              content: ev.patch,
            });
            this.bus.emitArtifact(runId, art);
            break;
          }
          case "final":
            finalOutput = ev.output ?? finalOutput;
            finalSummary = ev.summary ?? finalSummary;
            break;
        }
      }

      // Capture git diff if possible
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

        const statusArt = this.store.createArtifact({
          runId,
          nodeId: node.id,
          kind: "text",
          name: "git.status.txt",
          mimeType: "text/plain",
          content: diff.status,
          meta: { source: "git status --porcelain" },
        });
        this.bus.emitArtifact(runId, statusArt);
      }

      this.bus.emitNodePatch(runId, node.id, {
        status: "completed",
        completedAt: nowIso(),
        output: finalOutput,
        summary: finalSummary ?? "completed",
      }, "node.completed");

      return finalOutput;
    } catch (e: any) {
      this.bus.emitNodePatch(runId, node.id, {
        status: "failed",
        completedAt: nowIso(),
        error: { message: e?.message ?? String(e), stack: e?.stack },
      }, "node.failed");
      throw e;
    }
  }

  private async runVerificationNode(node: NodeRecord, signal: AbortSignal): Promise<boolean> {
    const runId = node.runId;
    this.bus.emitNodePatch(runId, node.id, { status: "running", startedAt: nowIso() }, "node.started");

    const run = this.store.getRun(runId)!;
    const commands = (this.cfg.verification.commands ?? []).filter((c) => String(c).trim().length);

    if (!commands.length) {
      this.bus.emitNodeProgress(runId, node.id, "No verification commands configured; treating as PASS.");
      this.bus.emitVerificationCompleted(runId, node.id, { ok: true, commands: [] });
      this.bus.emitNodePatch(runId, node.id, { status: "completed", completedAt: nowIso(), summary: "No verification commands (PASS)." }, "node.completed");
      return true;
    }

    const result = await verifyAll(commands, { cwd: run.repoPath, signal });
    const report = {
      ok: result.ok,
      commands: result.results.map((r) => ({
        command: r.command,
        ok: r.ok,
        code: r.code,
        durationMs: r.durationMs,
      })),
    };

    // persist logs per command
    const commandsOut = [];
    for (const r of result.results) {
      const combined = `# ${r.command}\n\nEXIT=${r.code}\n\n--- STDOUT ---\n${r.stdout}\n\n--- STDERR ---\n${r.stderr}\n`;
      const art = this.store.createArtifact({
        runId,
        nodeId: node.id,
        kind: "log",
        name: `verify_${sanitizeFileName(r.command)}.log`,
        mimeType: "text/plain",
        content: combined,
        meta: { command: r.command, ok: r.ok, code: r.code, durationMs: r.durationMs },
      });
      this.bus.emitArtifact(runId, art);
      commandsOut.push({ ...r, logArtifactId: art.id });
    }

    this.bus.emitVerificationCompleted(runId, node.id, {
      ok: result.ok,
      commands: commandsOut.map((r) => ({
        command: r.command,
        ok: r.ok,
        code: r.code,
        durationMs: r.durationMs,
        logArtifactId: r.logArtifactId,
      })),
    });

    if (result.ok) {
      this.bus.emitNodePatch(runId, node.id, { status: "completed", completedAt: nowIso(), summary: "Verification PASS." }, "node.completed");
      return true;
    } else {
      this.bus.emitNodePatch(runId, node.id, { status: "failed", completedAt: nowIso(), summary: "Verification FAIL." }, "node.failed");
      return false;
    }
  }

  private collectLatestVerificationLog(runId: string, verifyNodeId: string): string {
    const run = this.store.getRun(runId);
    if (!run) return "";
    // Collect the most recent verification log artifacts for this node.
    const logs = Object.values(run.artifacts)
      .filter((a) => a.nodeId === verifyNodeId && a.kind === "log")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 3);

    let combined = "";
    for (const a of logs) {
      try {
        combined += `\n\n## Artifact: ${a.name}\n`;
        combined += fs.readFileSync(a.path, "utf-8");
      } catch {
        // ignore
      }
    }
    return combined.trim();
  }

  private extractSteps(plan: any, fallbackPrompt: string, iteration: number, lastVerify: string): any[] {
    const maybeSteps = plan?.steps;
    if (Array.isArray(maybeSteps) && maybeSteps.length) return maybeSteps;

    // fallback plan
    return [
      {
        id: iteration === 0 ? "impl-1" : `fix-${iteration}`,
        title: iteration === 0 ? "Implement requested changes" : `Fix verification failures (iteration ${iteration})`,
        instructions: iteration === 0 ? fallbackPrompt : `Fix verification failures.\n\nLogs:\n${lastVerify}`,
        agentHint: "any",
        deps: [],
      },
    ];
  }

  // Prompt builders

  private buildInvestigationPrompt(userPrompt: string, repoPath: string): string {
    return [
      "You are an investigator agent inside vuhlp code.",
      "Goal: quickly understand the repo and identify how to validate changes.",
      "",
      `Repo path: ${repoPath}`,
      "",
      "Return a short summary and suggested verification commands.",
      "",
      "User request:",
      userPrompt,
    ].join("\n");
  }

  private buildPlanningPrompt(userPrompt: string, lastVerifyLog: string): string {
    return [
      "You are a planner agent inside vuhlp code.",
      "Create a minimal step plan to satisfy the user request.",
      "",
      "Rules:",
      "- Output JSON matching the provided schema (steps[], deps).",
      "- Prefer 1-5 steps.",
      "- Include deps only when required.",
      "",
      "User request:",
      userPrompt,
      "",
      lastVerifyLog ? `Recent verification failures (if any):\n${lastVerifyLog}` : "",
    ].join("\n");
  }

  private buildStepPrompt(userPrompt: string, step: any, iteration: number, lastVerifyLog: string): string {
    return [
      `You are an implementer agent inside vuhlp code.`,
      `Iteration: ${iteration}`,
      "",
      "User request:",
      userPrompt,
      "",
      "Your assigned step:",
      `Title: ${step.title ?? step.id}`,
      `Instructions: ${step.instructions ?? ""}`,
      "",
      lastVerifyLog ? `If you are fixing failures, use these logs:\n${lastVerifyLog}` : "",
      "",
      "Deliverables:",
      "- Apply code changes in the workspace.",
      "- Keep changes minimal.",
      "- If tests are available, run them (or suggest commands).",
      "- Summarize what you changed and why.",
    ].join("\n");
  }

  private buildReviewPrompt(userPrompt: string): string {
    return [
      "You are a reviewer agent inside vuhlp code.",
      "Review the implementation against the user request.",
      "Return JSON with fields: ok (boolean), issues (array), notes (string).",
      "",
      "User request:",
      userPrompt,
    ].join("\n");
  }
}

function sanitizeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}
