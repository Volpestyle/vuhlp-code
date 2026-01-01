import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import type { Kit, ModelRecord } from "@volpestyle/ai-kit-node";
import { ModelRouter } from "@volpestyle/ai-kit-node";
import type { ModelPolicy } from "../config";
import { Store } from "../runstore";
import type { Run, Step } from "../runstore/models";
import { ensureSpecFile } from "../util/spec";
import { runCommand } from "../util/exec";
import { applyUnifiedDiff } from "../util/patch";
import { gatherContext } from "./context";
import { generatePlan, PlanStep } from "./plan";

export class Runner {
  private running = new Set<string>();
  private router: ModelRouter;
  private policy: ModelPolicy;

  constructor(
    private store: Store,
    private kit: Kit,
    policy: ModelPolicy,
    router = new ModelRouter(),
  ) {
    this.router = router;
    this.policy = policy;
  }

  setPolicy(policy: ModelPolicy): void {
    this.policy = policy;
  }

  async startRun(runId: string): Promise<void> {
    if (this.running.has(runId)) return;
    this.running.add(runId);
    const controller = new AbortController();
    this.store.setRunCancel(runId, controller);
    this.execute(runId, controller.signal)
      .catch((err) => {
        console.error("run failed", { run_id: runId, err });
      })
      .finally(() => {
        this.running.delete(runId);
      });
  }

  private async execute(runId: string, signal: AbortSignal): Promise<void> {
    try {
      let run = await this.store.getRun(runId);
      run.status = "running";
      await this.store.updateRun(run);
      await this.store.appendEvent(runId, {
        ts: new Date().toISOString(),
        run_id: runId,
        type: "run_started",
        message: "run started",
      });

      const created = await ensureSpecFile(run.spec_path);
      if (created) {
        await this.store.appendEvent(runId, {
          ts: new Date().toISOString(),
          run_id: runId,
          type: "spec_created",
          data: { spec_path: run.spec_path },
        });
      }

      const specText = await Bun.file(run.spec_path).text();
      await this.store.appendEvent(runId, {
        ts: new Date().toISOString(),
        run_id: runId,
        type: "spec_loaded",
        data: { bytes: specText.length },
      });

      const bundle = await gatherContext(run.workspace_path, signal);
      await this.store.appendEvent(runId, {
        ts: new Date().toISOString(),
        run_id: runId,
        type: "context_gathered",
        data: {
          has_agents_md: Boolean(bundle.agents_md),
          repo_tree_len: bundle.repo_tree?.length ?? 0,
          repo_map_len: bundle.repo_map?.length ?? 0,
        },
      });

      const model = await this.resolveModel();
      run.model_canonical = model.id;
      await this.store.updateRun(run);
      await this.store.appendEvent(runId, {
        ts: new Date().toISOString(),
        run_id: runId,
        type: "model_resolved",
        data: { model: model.id },
      });

      const plan = await generatePlan(this.kit, model, specText, bundle);
      await this.store.appendEvent(runId, {
        ts: new Date().toISOString(),
        run_id: runId,
        type: "plan_generated",
        data: { steps: plan.steps.length },
      });

      run.steps = plan.steps.map((step) => ({
        id: step.id,
        title: step.title,
        type: step.type,
        needs_approval: step.needs_approval,
        command: step.command,
        status: "pending",
      })) as Step[];
      await this.store.updateRun(run);

      for (const step of plan.steps) {
        if (signal.aborted) {
          await this.cancelRun(runId, signal.reason ?? new Error("canceled"));
          return;
        }
        await this.executeStep(runId, step, signal);
      }

      run = await this.store.getRun(runId);
      run.status = "succeeded";
      run.error = "";
      await this.store.updateRun(run);
      await this.store.appendEvent(runId, {
        ts: new Date().toISOString(),
        run_id: runId,
        type: "run_succeeded",
        message: "run completed successfully",
      });
    } catch (err: unknown) {
      await this.failRun(runId, err as Error);
      throw err;
    }
  }

  private async resolveModel(): Promise<ModelRecord> {
    const records = await this.kit.listModelRecords();
    const resolved = this.router.resolve(records, {
      constraints: {
        requireTools: this.policy.require_tools,
        requireVision: this.policy.require_vision,
        maxCostUsd: this.policy.max_cost_usd,
      },
      preferredModels: this.policy.preferred_models,
    });
    return resolved.primary;
  }

  private async executeStep(runId: string, step: PlanStep, signal: AbortSignal): Promise<void> {
    await this.store.appendEvent(runId, {
      ts: new Date().toISOString(),
      run_id: runId,
      type: "step_started",
      data: {
        step_id: step.id,
        title: step.title,
        type: step.type,
      },
    });

    let run = await this.store.getRun(runId);
    run.steps = run.steps ?? [];
    for (const item of run.steps) {
      if (item.id === step.id) {
        item.status = "running";
        item.started_at = new Date().toISOString();
      }
    }
    await this.store.updateRun(run);

    if (step.needs_approval) {
      run.status = "waiting_approval";
      for (const item of run.steps ?? []) {
        if (item.id === step.id) item.status = "waiting_approval";
      }
      await this.store.updateRun(run);
      await this.store.requireApproval(runId, step.id);
      await this.store.appendEvent(runId, {
        ts: new Date().toISOString(),
        run_id: runId,
        type: "approval_requested",
        data: { step_id: step.id, title: step.title },
      });
      await this.store.waitForApproval(runId, step.id, signal);
      run = await this.store.getRun(runId);
      run.status = "running";
      for (const item of run.steps ?? []) {
        if (item.id === step.id) item.status = "running";
      }
      await this.store.updateRun(run);
    }

    switch (step.type.toLowerCase()) {
      case "command":
        await this.execCommandStep(runId, step, signal);
        break;
      case "patch":
        await this.execPatchStep(runId, step, signal);
        break;
      case "diagram":
        await this.execCommandStep(
          runId,
          { ...step, type: "command", command: "make diagrams" },
          signal,
        );
        break;
      default:
        await this.completeStep(runId, step.id, true, "");
    }
  }

  private async execCommandStep(runId: string, step: PlanStep, signal: AbortSignal): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!step.command?.trim()) {
      await this.completeStep(runId, step.id, true, "no command (skipped)");
      return;
    }
    let result: unknown = {};
    let ok = true;
    try {
      result = await runCommand(step.command, { dir: run.workspace_path, timeoutMs: 30 * 60_000, signal });
    } catch (err: unknown) {
      ok = false;
      result = (err as { result?: unknown }).result ?? { error: (err as Error).message };
    }
    const artifactPath = await this.writeArtifact(runId, step.id, "command.json", JSON.stringify(result, null, 2));
    await this.store.appendEvent(runId, {
      ts: new Date().toISOString(),
      run_id: runId,
      type: "command_executed",
      data: {
        step_id: step.id,
        cmd: step.command,
        exit_code: (result as { exit_code?: number })?.exit_code ?? 1,
        artifact_rel: artifactPath,
      },
    });
    if (!ok) {
      await this.completeStep(runId, step.id, false, "command failed");
      throw new Error("command failed");
    }
    await this.completeStep(runId, step.id, true, "");
  }

  private async execPatchStep(runId: string, step: PlanStep, signal: AbortSignal): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!step.patch?.trim()) {
      await this.completeStep(runId, step.id, true, "no patch (skipped)");
      return;
    }
    let result: unknown = {};
    let ok = true;
    try {
      result = await applyUnifiedDiff(run.workspace_path, step.patch, signal);
    } catch (err: unknown) {
      ok = false;
      result = (err as { result?: unknown }).result ?? { applied: false, error: (err as Error).message };
    }
    const artifactPath = await this.writeArtifact(
      runId,
      step.id,
      "patch_apply.json",
      JSON.stringify(result, null, 2),
    );
    await this.store.appendEvent(runId, {
      ts: new Date().toISOString(),
      run_id: runId,
      type: "patch_applied",
      data: { step_id: step.id, applied: (result as { applied?: boolean })?.applied ?? false, artifact_rel: artifactPath },
    });
    if (!ok) {
      await this.completeStep(runId, step.id, false, "patch apply error");
      throw new Error("patch apply error");
    }
    await this.completeStep(runId, step.id, true, "");
  }

  private async completeStep(runId: string, stepId: string, ok: boolean, msg: string): Promise<void> {
    const run = await this.store.getRun(runId);
    for (const item of run.steps ?? []) {
      if (item.id === stepId) {
        item.completed_at = new Date().toISOString();
        item.status = ok ? "succeeded" : "failed";
      }
    }
    await this.store.updateRun(run);
    await this.store.appendEvent(runId, {
      ts: new Date().toISOString(),
      run_id: runId,
      type: ok ? "step_completed" : "step_failed",
      message: msg,
      data: { step_id: stepId, ok },
    });
  }

  private async writeArtifact(runId: string, stepId: string, name: string, content: string): Promise<string> {
    const dir = path.join(this.store.dataDirectory(), "runs", runId, "artifacts", stepId);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    const abs = path.join(dir, name);
    await writeFile(abs, content + (content.endsWith("\n") ? "" : "\n"), { mode: 0o644 });
    return path.posix.join("artifacts", stepId, name);
  }

  private async failRun(runId: string, err: Error): Promise<void> {
    const run = await this.store.getRun(runId);
    run.status = "failed";
    run.error = err.message;
    await this.store.updateRun(run);
    await this.store.appendEvent(runId, {
      ts: new Date().toISOString(),
      run_id: runId,
      type: "run_failed",
      message: err.message,
    });
  }

  private async cancelRun(runId: string, err: unknown): Promise<void> {
    const run = await this.store.getRun(runId);
    run.status = "canceled";
    run.error = "";
    await this.store.updateRun(run);
    await this.store.appendEvent(runId, {
      ts: new Date().toISOString(),
      run_id: runId,
      type: "run_canceled",
      message: (err as Error)?.message ?? "canceled",
    });
  }
}
