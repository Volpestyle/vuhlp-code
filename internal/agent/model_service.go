package agent

import (
	"context"
	"sync"

	aikit "github.com/Volpestyle/ai-kit/packages/go"
	"github.com/yourorg/coding-agent-harness/internal/config"
)

type ModelService struct {
	Kit          *aikit.Kit
	settingsPath string

	policyMu sync.RWMutex
	policy   config.ModelPolicy

	runner        *Runner
	sessionRunner *SessionRunner
}

func NewModelService(kit *aikit.Kit, policy config.ModelPolicy, settingsPath string, runner *Runner, sessionRunner *SessionRunner) *ModelService {
	return &ModelService{
		Kit:           kit,
		settingsPath:  settingsPath,
		policy:        policy,
		runner:        runner,
		sessionRunner: sessionRunner,
	}
}

func (s *ModelService) ListModels(ctx context.Context) ([]aikit.ModelRecord, error) {
	if s.Kit == nil {
		return nil, nil
	}
	return s.Kit.ListModelRecords(ctx, nil)
}

func (s *ModelService) GetPolicy() config.ModelPolicy {
	s.policyMu.RLock()
	defer s.policyMu.RUnlock()
	return s.policy
}

func (s *ModelService) SetPolicy(policy config.ModelPolicy) error {
	s.policyMu.Lock()
	s.policy = policy
	s.policyMu.Unlock()

	if s.runner != nil {
		s.runner.SetPolicy(policy)
	}
	if s.sessionRunner != nil {
		s.sessionRunner.SetPolicy(policy)
	}
	return config.SaveSettings(s.settingsPath, config.Settings{ModelPolicy: policy})
}
