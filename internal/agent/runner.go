package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	aikit "github.com/Volpestyle/ai-kit/packages/go"
	"github.com/yourorg/coding-agent-harness/internal/config"
	"github.com/yourorg/coding-agent-harness/internal/runstore"
	"github.com/yourorg/coding-agent-harness/internal/util"
)

type Runner struct {
	Logger *slog.Logger
	Store  *runstore.Store

	Kit    *aikit.Kit
	Router *aikit.ModelRouter

	Policy config.ModelPolicy

	mu      sync.Mutex
	running map[string]struct{}
}

func NewRunner(logger *slog.Logger, store *runstore.Store, kit *aikit.Kit, router *aikit.ModelRouter, policy config.ModelPolicy) *Runner {
	if logger == nil {
		logger = slog.Default()
	}
	return &Runner{
		Logger:  logger,
		Store:   store,
		Kit:     kit,
		Router:  router,
		Policy:  policy,
		running: map[string]struct{}{},
	}
}

// StartRun spawns a goroutine to execute the run if it isn't already running.
func (r *Runner) StartRun(ctx context.Context, runID string) error {
	r.mu.Lock()
	if _, ok := r.running[runID]; ok {
		r.mu.Unlock()
		return nil
	}
	r.running[runID] = struct{}{}
	r.mu.Unlock()

	go func() {
		defer func() {
			r.mu.Lock()
			delete(r.running, runID)
			r.mu.Unlock()
		}()

		runCtx, cancel := context.WithCancel(context.Background())
		r.Store.SetRunCancel(runID, cancel)
		defer cancel()

		if err := r.execute(runCtx, runID); err != nil {
			r.Logger.Error("run failed", "run_id", runID, "err", err)
		}
	}()
	return nil
}

func (r *Runner) execute(ctx context.Context, runID string) error {
	run, err := r.Store.GetRun(runID)
	if err != nil {
		return err
	}

	run.Status = runstore.RunRunning
	_ = r.Store.UpdateRun(run)
	_ = r.Store.AppendEvent(runID, runstore.Event{
		TS:      time.Now().UTC(),
		RunID:   runID,
		Type:    "run_started",
		Message: "run started",
	})

	specBytes, err := os.ReadFile(run.SpecPath)
	if err != nil {
		return r.failRun(runID, fmt.Errorf("read spec: %w", err))
	}
	specText := string(specBytes)
	_ = r.Store.AppendEvent(runID, runstore.Event{
		TS:    time.Now().UTC(),
		RunID: runID,
		Type:  "spec_loaded",
		Data: map[string]any{
			"bytes": len(specBytes),
		},
	})

	bundle, err := GatherContext(ctx, run.WorkspacePath)
	if err != nil {
		return r.failRun(runID, fmt.Errorf("gather context: %w", err))
	}
	_ = r.Store.AppendEvent(runID, runstore.Event{
		TS:    time.Now().UTC(),
		RunID: runID,
		Type:  "context_gathered",
		Data: map[string]any{
			"has_agents_md": bundle.AgentsMD != "",
			"repo_tree_len": len(bundle.RepoTree),
			"repo_map_len":  len(bundle.RepoMap),
		},
	})

	model, err := r.resolveModel(ctx)
	if err != nil {
		return r.failRun(runID, fmt.Errorf("resolve model: %w", err))
	}
	run.ModelCanonical = model.ID
	_ = r.Store.UpdateRun(run)
	_ = r.Store.AppendEvent(runID, runstore.Event{
		TS:    time.Now().UTC(),
		RunID: runID,
		Type:  "model_resolved",
		Data: map[string]any{
			"model": model.ID,
		},
	})

	plan, err := GeneratePlan(ctx, r.Kit, model, specText, bundle)
	if err != nil {
		return r.failRun(runID, fmt.Errorf("generate plan: %w", err))
	}
	_ = r.Store.AppendEvent(runID, runstore.Event{
		TS:    time.Now().UTC(),
		RunID: runID,
		Type:  "plan_generated",
		Data: map[string]any{
			"steps": len(plan.Steps),
		},
	})

	runSteps := make([]runstore.Step, 0, len(plan.Steps))
	for _, ps := range plan.Steps {
		runSteps = append(runSteps, runstore.Step{
			ID:            ps.ID,
			Title:         ps.Title,
			Type:          ps.Type,
			NeedsApproval: ps.NeedsApproval,
			Command:       ps.Command,
			Status:        runstore.StepPending,
		})
	}
	run.Steps = runSteps
	_ = r.Store.UpdateRun(run)

	for i := range plan.Steps {
		select {
		case <-ctx.Done():
			return r.cancelRun(runID, ctx.Err())
		default:
		}
		if err := r.executeStep(ctx, runID, &plan.Steps[i]); err != nil {
			return r.failRun(runID, err)
		}
	}

	run, _ = r.Store.GetRun(runID)
	run.Status = runstore.RunSucceeded
	run.Error = ""
	_ = r.Store.UpdateRun(run)
	_ = r.Store.AppendEvent(runID, runstore.Event{
		TS:      time.Now().UTC(),
		RunID:   runID,
		Type:    "run_succeeded",
		Message: "run completed successfully",
	})
	return nil
}

func (r *Runner) resolveModel(ctx context.Context) (aikit.ModelRecord, error) {
	records, err := r.Kit.ListModelRecords(ctx, nil)
	if err != nil {
		return aikit.ModelRecord{}, err
	}
	if r.Router == nil {
		r.Router = &aikit.ModelRouter{}
	}
	resolved, err := r.Router.Resolve(records, aikit.ModelResolutionRequest{
		Constraints: aikit.ModelConstraints{
			RequireTools:  r.Policy.RequireTools,
			RequireVision: r.Policy.RequireVision,
			MaxCostUSD:    r.Policy.MaxCostUSD,
		},
		PreferredModels: r.Policy.PreferredModels,
	})
	if err != nil {
		return aikit.ModelRecord{}, err
	}
	return resolved.Primary, nil
}

func (r *Runner) executeStep(ctx context.Context, runID string, step *PlanStep) error {
	if step == nil {
		return errors.New("step is nil")
	}

	_ = r.Store.AppendEvent(runID, runstore.Event{
		TS:    time.Now().UTC(),
		RunID: runID,
		Type:  "step_started",
		Data: map[string]any{
			"step_id": step.ID,
			"title":   step.Title,
			"type":    step.Type,
		},
	})

	run, _ := r.Store.GetRun(runID)
	for i := range run.Steps {
		if run.Steps[i].ID == step.ID {
			now := time.Now().UTC()
			run.Steps[i].Status = runstore.StepRunning
			run.Steps[i].StartedAt = &now
		}
	}
	_ = r.Store.UpdateRun(run)

	if step.NeedsApproval {
		run.Status = runstore.RunWaitingApproval
		for i := range run.Steps {
			if run.Steps[i].ID == step.ID {
				run.Steps[i].Status = runstore.StepWaiting
			}
		}
		_ = r.Store.UpdateRun(run)

		if _, err := r.Store.RequireApproval(runID, step.ID); err != nil {
			return err
		}
		_ = r.Store.AppendEvent(runID, runstore.Event{
			TS:    time.Now().UTC(),
			RunID: runID,
			Type:  "approval_requested",
			Data: map[string]any{
				"step_id": step.ID,
				"title":   step.Title,
			},
		})

		if err := r.Store.WaitForApproval(ctx, runID, step.ID); err != nil {
			return err
		}

		run, _ = r.Store.GetRun(runID)
		run.Status = runstore.RunRunning
		for i := range run.Steps {
			if run.Steps[i].ID == step.ID {
				run.Steps[i].Status = runstore.StepRunning
			}
		}
		_ = r.Store.UpdateRun(run)
	}

	switch strings.ToLower(step.Type) {
	case "command":
		return r.execCommandStep(ctx, runID, *step)
	case "patch":
		return r.execPatchStep(ctx, runID, *step)
	case "diagram":
		return r.execCommandStep(ctx, runID, PlanStep{
			ID:            step.ID,
			Title:         step.Title,
			Type:          "command",
			NeedsApproval: step.NeedsApproval,
			Command:       "make diagrams",
		})
	default:
		// note/noop
	}

	return r.completeStep(runID, step.ID, true, "")
}

func (r *Runner) execCommandStep(ctx context.Context, runID string, step PlanStep) error {
	run, err := r.Store.GetRun(runID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(step.Command) == "" {
		return r.completeStep(runID, step.ID, true, "no command (skipped)")
	}
	res, cmdErr := util.RunCommand(ctx, step.Command, util.ExecOptions{
		Dir:     run.WorkspacePath,
		Timeout: 30 * time.Minute,
	})

	artifactPath := r.writeArtifact(runID, step.ID, "command.json", mustJSON(res))
	_ = r.Store.AppendEvent(runID, runstore.Event{
		TS:    time.Now().UTC(),
		RunID: runID,
		Type:  "command_executed",
		Data: map[string]any{
			"step_id":      step.ID,
			"cmd":          step.Command,
			"exit_code":    res.ExitCode,
			"artifact_rel": artifactPath,
		},
	})

	if cmdErr != nil {
		return r.completeStep(runID, step.ID, false, fmt.Sprintf("command failed (exit %d)", res.ExitCode))
	}
	return r.completeStep(runID, step.ID, true, "")
}

func (r *Runner) execPatchStep(ctx context.Context, runID string, step PlanStep) error {
	run, err := r.Store.GetRun(runID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(step.Patch) == "" {
		return r.completeStep(runID, step.ID, true, "no patch (skipped)")
	}
	res, err := util.ApplyUnifiedDiff(ctx, run.WorkspacePath, step.Patch)
	artifactPath := r.writeArtifact(runID, step.ID, "patch_apply.json", mustJSON(res))
	_ = r.Store.AppendEvent(runID, runstore.Event{
		TS:    time.Now().UTC(),
		RunID: runID,
		Type:  "patch_applied",
		Data: map[string]any{
			"step_id":      step.ID,
			"applied":      res.Applied,
			"artifact_rel": artifactPath,
		},
	})
	if err != nil {
		return r.completeStep(runID, step.ID, false, fmt.Sprintf("patch apply error: %v", err))
	}
	return r.completeStep(runID, step.ID, true, "")
}

func (r *Runner) completeStep(runID, stepID string, ok bool, msg string) error {
	run, _ := r.Store.GetRun(runID)

	now := time.Now().UTC()
	for i := range run.Steps {
		if run.Steps[i].ID == stepID {
			run.Steps[i].CompletedAt = &now
			if ok {
				run.Steps[i].Status = runstore.StepSucceeded
			} else {
				run.Steps[i].Status = runstore.StepFailed
			}
		}
	}
	_ = r.Store.UpdateRun(run)

	evType := "step_completed"
	if !ok {
		evType = "step_failed"
	}
	_ = r.Store.AppendEvent(runID, runstore.Event{
		TS:      time.Now().UTC(),
		RunID:   runID,
		Type:    evType,
		Message: msg,
		Data: map[string]any{
			"step_id": stepID,
			"ok":      ok,
		},
	})

	if !ok {
		return errors.New(msg)
	}
	return nil
}

func (r *Runner) writeArtifact(runID, stepID, name string, content []byte) string {
	dir := filepath.Join(r.Store.DataDir(), "runs", runID, "artifacts", stepID)
	_ = os.MkdirAll(dir, 0o755)
	abs := filepath.Join(dir, name)
	_ = os.WriteFile(abs, content, 0o644)
	rel := filepath.ToSlash(filepath.Join("artifacts", stepID, name))
	return rel
}

func mustJSON(v any) []byte {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return []byte("{}")
	}
	return append(b, '\n')
}

func (r *Runner) failRun(runID string, err error) error {
	run, _ := r.Store.GetRun(runID)
	run.Status = runstore.RunFailed
	run.Error = err.Error()
	_ = r.Store.UpdateRun(run)
	_ = r.Store.AppendEvent(runID, runstore.Event{
		TS:      time.Now().UTC(),
		RunID:   runID,
		Type:    "run_failed",
		Message: err.Error(),
	})
	return err
}

func (r *Runner) cancelRun(runID string, err error) error {
	run, _ := r.Store.GetRun(runID)
	run.Status = runstore.RunCanceled
	run.Error = ""
	_ = r.Store.UpdateRun(run)
	_ = r.Store.AppendEvent(runID, runstore.Event{
		TS:      time.Now().UTC(),
		RunID:   runID,
		Type:    "run_canceled",
		Message: err.Error(),
	})
	return err
}
