package agent

import (
	"context"
	"encoding/base64"
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

type SessionRunner struct {
	Logger         *slog.Logger
	Store          *runstore.Store
	Kit            *aikit.Kit
	Router         *aikit.ModelRouter
	Policy         config.ModelPolicy
	ToolsFactory   func(workspace string, verify VerifyPolicy) ToolRegistry
	VerifyPolicy   VerifyPolicy
	ApprovalPolicy ApprovalPolicy
	Adapter        AikitAdapter

	policyMu sync.RWMutex
	mu       sync.Mutex
	running  map[string]struct{}
}

func NewSessionRunner(logger *slog.Logger, store *runstore.Store, kit *aikit.Kit, router *aikit.ModelRouter, policy config.ModelPolicy) *SessionRunner {
	if logger == nil {
		logger = slog.Default()
	}
	return &SessionRunner{
		Logger:         logger,
		Store:          store,
		Kit:            kit,
		Router:         router,
		Policy:         policy,
		ToolsFactory:   DefaultToolRegistry,
		VerifyPolicy:   DefaultVerifyPolicy(),
		ApprovalPolicy: DefaultApprovalPolicy(),
		Adapter:        AikitAdapter{},
		running:        map[string]struct{}{},
	}
}

func (r *SessionRunner) SetPolicy(policy config.ModelPolicy) {
	r.policyMu.Lock()
	r.Policy = policy
	r.policyMu.Unlock()
}

func (r *SessionRunner) policySnapshot() config.ModelPolicy {
	r.policyMu.RLock()
	defer r.policyMu.RUnlock()
	return r.Policy
}

func (r *SessionRunner) StartTurn(ctx context.Context, sessionID, turnID string) error {
	r.mu.Lock()
	if _, ok := r.running[sessionID]; ok {
		r.mu.Unlock()
		return fmt.Errorf("session already running: %s", sessionID)
	}
	r.running[sessionID] = struct{}{}
	r.mu.Unlock()

	go func() {
		defer func() {
			r.mu.Lock()
			delete(r.running, sessionID)
			r.mu.Unlock()
		}()

		runCtx, cancel := context.WithCancel(context.Background())
		r.Store.SetSessionCancel(sessionID, cancel)
		defer cancel()

		if err := r.executeTurn(runCtx, sessionID, turnID); err != nil {
			r.Logger.Error("session turn failed", "session_id", sessionID, "turn_id", turnID, "err", err)
		}
	}()
	return nil
}

func (r *SessionRunner) executeTurn(ctx context.Context, sessionID, turnID string) error {
	session, err := r.Store.GetSession(sessionID)
	if err != nil {
		return err
	}
	turnIdx := -1
	for i := range session.Turns {
		if session.Turns[i].ID == turnID {
			turnIdx = i
			break
		}
	}
	if turnIdx == -1 {
		return fmt.Errorf("turn not found: %s", turnID)
	}

	now := time.Now().UTC()
	session.Status = runstore.SessionActive
	session.LastTurnID = turnID
	session.Turns[turnIdx].Status = runstore.TurnRunning
	session.Turns[turnIdx].StartedAt = &now
	session.Turns[turnIdx].Error = ""
	if err := r.Store.UpdateSession(session); err != nil {
		return err
	}
	_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: sessionID,
		TurnID:    turnID,
		Type:      "turn_started",
	})

	bundle, err := GatherContext(ctx, session.WorkspacePath)
	if err != nil {
		return r.failTurn(sessionID, turnID, fmt.Errorf("gather context: %w", err))
	}

	model, err := r.resolveModel(ctx)
	if err != nil {
		return r.failTurn(sessionID, turnID, fmt.Errorf("resolve model: %w", err))
	}
	_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: sessionID,
		TurnID:    turnID,
		Type:      "model_resolved",
		Data: map[string]any{
			"model": model.ID,
		},
	})

	maxTurns := 8
	workspaceDirty := false
	toolFactory := r.ToolsFactory
	if toolFactory == nil {
		toolFactory = DefaultToolRegistry
	}
	toolRegistry := toolFactory(session.WorkspacePath, r.VerifyPolicy)
	if session.Mode == runstore.SessionModeSpec {
		if strings.TrimSpace(session.SpecPath) == "" {
			defaultPath, err := util.DefaultSpecPath(session.WorkspacePath, "session-"+session.ID)
			if err != nil {
				return r.failTurn(sessionID, turnID, fmt.Errorf("default spec path: %w", err))
			}
			session.SpecPath = defaultPath
			if err := r.Store.UpdateSession(session); err != nil {
				return r.failTurn(sessionID, turnID, fmt.Errorf("update session: %w", err))
			}
			_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
				TS:        time.Now().UTC(),
				SessionID: sessionID,
				TurnID:    turnID,
				Type:      "spec_path_set",
				Data: map[string]any{
					"spec_path": session.SpecPath,
				},
			})
		}
		created, err := util.EnsureSpecFile(session.SpecPath)
		if err != nil {
			return r.failTurn(sessionID, turnID, fmt.Errorf("ensure spec: %w", err))
		}
		if created {
			_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
				TS:        time.Now().UTC(),
				SessionID: sessionID,
				TurnID:    turnID,
				Type:      "spec_created",
				Data: map[string]any{
					"spec_path": session.SpecPath,
				},
			})
		}
		toolRegistry.Add(SpecReadTool{SpecPath: session.SpecPath})
		toolRegistry.Add(SpecWriteTool{SpecPath: session.SpecPath})
		toolRegistry.Add(SpecValidateTool{SpecPath: session.SpecPath})
	}

	for attempt := 0; attempt < maxTurns; attempt++ {
		select {
		case <-ctx.Done():
			return r.cancelTurn(sessionID, turnID, ctx.Err())
		default:
		}

		aikitMessages, err := r.buildAikitMessages(session, bundle, model.Provider)
		if err != nil {
			return r.failTurn(sessionID, turnID, err)
		}
		tools := r.Adapter.ToAikitTools(toolRegistry.Definitions())

		assistantText, toolCalls, err := r.streamModel(ctx, sessionID, turnID, model, aikitMessages, tools)
		if err != nil {
			return r.failTurn(sessionID, turnID, err)
		}
		if strings.TrimSpace(assistantText) != "" {
			msg := runstore.Message{
				ID:        util.NewMessageID(),
				Role:      "assistant",
				Parts:     []runstore.MessagePart{{Type: "text", Text: assistantText}},
				CreatedAt: time.Now().UTC(),
			}
			if _, err := r.Store.AppendMessage(sessionID, msg); err != nil {
				return r.failTurn(sessionID, turnID, err)
			}
			_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
				TS:        time.Now().UTC(),
				SessionID: sessionID,
				TurnID:    turnID,
				Type:      "message_added",
				Data: map[string]any{
					"message_id": msg.ID,
					"role":       msg.Role,
				},
			})
			session.Messages = append(session.Messages, msg)
		}

		if len(toolCalls) == 0 {
			if r.VerifyPolicy.AutoVerify && workspaceDirty {
				verifyResult, err := r.invokeVerify(ctx, sessionID, turnID, toolRegistry)
				if err != nil {
					session.Messages = append(session.Messages, verifyResult)
					continue
				}
				session.Messages = append(session.Messages, verifyResult)
			}
			return r.completeTurn(sessionID, turnID)
		}

		for _, call := range toolCalls {
			tool, ok := toolRegistry.Get(call.Name)
			if !ok {
				return r.failTurn(sessionID, turnID, fmt.Errorf("unknown tool: %s", call.Name))
			}
			if r.requiresApproval(tool.Definition()) {
				session.Status = runstore.SessionWaitingApproval
				for i := range session.Turns {
					if session.Turns[i].ID == turnID {
						session.Turns[i].Status = runstore.TurnWaitingApproval
					}
				}
				_ = r.Store.UpdateSession(session)
				if _, err := r.Store.RequireSessionApproval(sessionID, call.ID); err != nil {
					return r.failTurn(sessionID, turnID, err)
				}
				_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
					TS:        time.Now().UTC(),
					SessionID: sessionID,
					TurnID:    turnID,
					Type:      "approval_requested",
					Data: map[string]any{
						"tool":         call.Name,
						"tool_call_id": call.ID,
					},
				})

				decision, err := r.Store.WaitForSessionApproval(ctx, sessionID, call.ID)
				if err != nil {
					return r.failTurn(sessionID, turnID, err)
				}
				if decision.Action == "deny" {
					_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
						TS:        time.Now().UTC(),
						SessionID: sessionID,
						TurnID:    turnID,
						Type:      "approval_denied",
						Data: map[string]any{
							"tool":         call.Name,
							"tool_call_id": call.ID,
							"reason":       decision.Reason,
						},
					})
					return r.failTurn(sessionID, turnID, errors.New("approval denied"))
				}
				session.Status = runstore.SessionActive
				for i := range session.Turns {
					if session.Turns[i].ID == turnID {
						session.Turns[i].Status = runstore.TurnRunning
					}
				}
				_ = r.Store.UpdateSession(session)
				_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
					TS:        time.Now().UTC(),
					SessionID: sessionID,
					TurnID:    turnID,
					Type:      "approval_granted",
					Data: map[string]any{
						"tool":         call.Name,
						"tool_call_id": call.ID,
						"reason":       decision.Reason,
					},
				})
			}

			_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
				TS:        time.Now().UTC(),
				SessionID: sessionID,
				TurnID:    turnID,
				Type:      "tool_call_started",
				Data: map[string]any{
					"tool":         call.Name,
					"tool_call_id": call.ID,
				},
			})

			result, err := toolRegistry.Invoke(ctx, call)
			if err != nil {
				result.OK = false
				result.Error = err.Error()
			}
			_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
				TS:        time.Now().UTC(),
				SessionID: sessionID,
				TurnID:    turnID,
				Type:      "tool_call_completed",
				Data: map[string]any{
					"tool":         call.Name,
					"tool_call_id": call.ID,
					"ok":           result.OK,
					"error":        result.Error,
				},
			})

			toolMsg := runstore.Message{
				ID:         util.NewMessageID(),
				Role:       "tool",
				ToolCallID: call.ID,
				Parts:      result.Parts,
				CreatedAt:  time.Now().UTC(),
			}
			if _, err := r.Store.AppendMessage(sessionID, toolMsg); err != nil {
				return r.failTurn(sessionID, turnID, err)
			}
			_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
				TS:        time.Now().UTC(),
				SessionID: sessionID,
				TurnID:    turnID,
				Type:      "message_added",
				Data: map[string]any{
					"message_id": toolMsg.ID,
					"role":       toolMsg.Role,
				},
			})
			session.Messages = append(session.Messages, toolMsg)

			def := tool.Definition()
			if def.Kind == ToolKindWrite || def.Kind == ToolKindExec {
				if !(session.Mode == runstore.SessionModeSpec && call.Name == "write_spec") {
					workspaceDirty = true
				}
			}

			if session.Mode == runstore.SessionModeSpec && call.Name == "write_spec" {
				validateMsg, err := r.invokeSpecValidate(ctx, sessionID, turnID, toolRegistry)
				session.Messages = append(session.Messages, validateMsg)
				if err != nil {
					continue
				}
			}

			if !result.OK {
				// Let the model react to tool failures in the next loop iteration.
				break
			}
		}
	}

	return r.failTurn(sessionID, turnID, errors.New("max turn iterations reached"))
}

func (r *SessionRunner) resolveModel(ctx context.Context) (aikit.ModelRecord, error) {
	records, err := r.Kit.ListModelRecords(ctx, nil)
	if err != nil {
		return aikit.ModelRecord{}, err
	}
	if r.Router == nil {
		r.Router = &aikit.ModelRouter{}
	}
	policy := r.policySnapshot()
	resolved, err := r.Router.Resolve(records, aikit.ModelResolutionRequest{
		Constraints: aikit.ModelConstraints{
			RequireTools:  policy.RequireTools,
			RequireVision: policy.RequireVision,
			MaxCostUSD:    policy.MaxCostUSD,
		},
		PreferredModels: policy.PreferredModels,
	})
	if err != nil {
		return aikit.ModelRecord{}, err
	}
	return resolved.Primary, nil
}

func (r *SessionRunner) buildAikitMessages(session *runstore.Session, bundle ContextBundle, provider aikit.Provider) ([]aikit.Message, error) {
	var messages []runstore.Message
	if strings.TrimSpace(session.SystemPrompt) != "" {
		messages = append(messages, runstore.Message{
			ID:        util.NewMessageID(),
			Role:      "system",
			Parts:     []runstore.MessagePart{{Type: "text", Text: session.SystemPrompt}},
			CreatedAt: time.Now().UTC(),
		})
	}

	if session.Mode == runstore.SessionModeSpec {
		messages = append(messages, runstore.Message{
			ID:        util.NewMessageID(),
			Role:      "system",
			Parts:     []runstore.MessagePart{{Type: "text", Text: specModePrompt(session.SpecPath)}},
			CreatedAt: time.Now().UTC(),
		})
	}

	contextText := buildContextText(bundle)
	if contextText != "" {
		messages = append(messages, runstore.Message{
			ID:        util.NewMessageID(),
			Role:      "system",
			Parts:     []runstore.MessagePart{{Type: "text", Text: contextText}},
			CreatedAt: time.Now().UTC(),
		})
	}

	if session.Mode == runstore.SessionModeSpec && session.SpecPath != "" {
		if content, err := os.ReadFile(session.SpecPath); err == nil && strings.TrimSpace(string(content)) != "" {
			messages = append(messages, runstore.Message{
				ID:        util.NewMessageID(),
				Role:      "system",
				Parts:     []runstore.MessagePart{{Type: "text", Text: fmt.Sprintf("CURRENT SPEC (%s):\n%s", session.SpecPath, string(content))}},
				CreatedAt: time.Now().UTC(),
			})
		}
	}

	messages = append(messages, r.prepareSessionMessages(session.Messages, provider)...)
	return r.toAikitMessages(session.ID, messages)
}

func buildContextText(bundle ContextBundle) string {
	var b strings.Builder
	b.WriteString("Workspace context:\n")
	if bundle.AgentsMD != "" {
		b.WriteString("AGENTS.md:\n")
		b.WriteString(bundle.AgentsMD)
		b.WriteString("\n\n")
	}
	if bundle.RepoTree != "" {
		b.WriteString("REPO TREE:\n")
		b.WriteString(bundle.RepoTree)
		b.WriteString("\n\n")
	}
	if bundle.RepoMap != "" {
		b.WriteString("REPO MAP:\n")
		b.WriteString(bundle.RepoMap)
		b.WriteString("\n\n")
	}
	if bundle.GitStatus != "" {
		b.WriteString("GIT STATUS:\n")
		b.WriteString(bundle.GitStatus)
		b.WriteString("\n\n")
	}
	return strings.TrimSpace(b.String())
}

func (r *SessionRunner) prepareSessionMessages(messages []runstore.Message, provider aikit.Provider) []runstore.Message {
	if provider != aikit.ProviderOpenAI {
		return messages
	}
	out := make([]runstore.Message, 0, len(messages))
	for _, msg := range messages {
		if msg.Role != "tool" {
			out = append(out, msg)
			continue
		}
		text := toolMessageText(msg.Parts)
		if strings.TrimSpace(text) == "" {
			text = "(no output)"
		}
		label := "TOOL OUTPUT"
		if msg.ToolCallID != "" {
			label = fmt.Sprintf("TOOL OUTPUT (%s)", msg.ToolCallID)
		}
		out = append(out, runstore.Message{
			ID:        msg.ID,
			Role:      "assistant",
			Parts:     []runstore.MessagePart{{Type: "text", Text: label + ":\n" + text}},
			CreatedAt: msg.CreatedAt,
		})
	}
	return out
}

func toolMessageText(parts []runstore.MessagePart) string {
	if len(parts) == 0 {
		return ""
	}
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		switch part.Type {
		case "text":
			if strings.TrimSpace(part.Text) != "" {
				out = append(out, part.Text)
			}
		default:
			if strings.TrimSpace(part.Ref) != "" {
				out = append(out, fmt.Sprintf("[%s: %s]", part.Type, part.Ref))
			}
		}
	}
	return strings.Join(out, "\n")
}

func specModePrompt(specPath string) string {
	var b strings.Builder
	b.WriteString("You are in spec-session mode.\n")
	b.WriteString("Keep the spec as the primary artifact and update it using the write_spec tool.\n")
	b.WriteString("The spec must include headings: # Goal, # Constraints / nuances, # Acceptance tests.\n")
	if strings.TrimSpace(specPath) != "" {
		b.WriteString("Spec path: ")
		b.WriteString(specPath)
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String())
}

func (r *SessionRunner) toAikitMessages(sessionID string, messages []runstore.Message) ([]aikit.Message, error) {
	out := make([]aikit.Message, 0, len(messages))
	for _, msg := range messages {
		parts := make([]aikit.ContentPart, 0, len(msg.Parts))
		for _, part := range msg.Parts {
			switch part.Type {
			case "text":
				parts = append(parts, aikit.ContentPart{Type: "text", Text: part.Text})
			case "image":
				img, ok := r.loadImageAttachment(sessionID, part.Ref, part.MimeType)
				if ok {
					parts = append(parts, aikit.ContentPart{
						Type:  "image",
						Image: img,
					})
				} else {
					parts = append(parts, aikit.ContentPart{Type: "text", Text: fmt.Sprintf("[image: %s]", part.Ref)})
				}
			default:
				if part.Ref != "" {
					parts = append(parts, aikit.ContentPart{Type: "text", Text: fmt.Sprintf("[%s: %s]", part.Type, part.Ref)})
				} else if part.Text != "" {
					parts = append(parts, aikit.ContentPart{Type: "text", Text: part.Text})
				}
			}
		}
		out = append(out, aikit.Message{
			Role:       msg.Role,
			Content:    parts,
			ToolCallID: msg.ToolCallID,
		})
	}
	return out, nil
}

func (r *SessionRunner) loadImageAttachment(sessionID, ref, mimeType string) (*aikit.ImageContent, bool) {
	if ref == "" {
		return nil, false
	}
	path := filepath.Join(r.Store.DataDir(), "sessions", sessionID, filepath.FromSlash(ref))
	path = filepath.Clean(path)
	if !strings.HasPrefix(path, filepath.Join(r.Store.DataDir(), "sessions", sessionID)) {
		return nil, false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	if mimeType == "" {
		mimeType = "image/png"
	}
	return &aikit.ImageContent{
		Base64:    base64.StdEncoding.EncodeToString(b),
		MediaType: mimeType,
	}, true
}

func (r *SessionRunner) streamModel(ctx context.Context, sessionID, turnID string, model aikit.ModelRecord, messages []aikit.Message, tools []aikit.ToolDefinition) (string, []ToolCall, error) {
	stream, err := r.Kit.StreamGenerate(ctx, aikit.GenerateInput{
		Provider: model.Provider,
		Model:    model.ProviderModelID,
		Messages: messages,
		Tools:    tools,
		Stream:   true,
	})
	if err != nil {
		return "", nil, err
	}
	var assistant strings.Builder
	callsByID := map[string]ToolCall{}
	callOrder := make([]string, 0, 4)

	for chunk := range stream {
		switch chunk.Type {
		case aikit.StreamChunkDelta:
			if chunk.TextDelta != "" {
				assistant.WriteString(chunk.TextDelta)
				_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
					TS:        time.Now().UTC(),
					SessionID: sessionID,
					TurnID:    turnID,
					Type:      "model_output_delta",
					Data: map[string]any{
						"delta": chunk.TextDelta,
					},
				})
			}
		case aikit.StreamChunkToolCall:
			if chunk.Call != nil {
				call := r.Adapter.FromAikitCall(*chunk.Call)
				if call.ID == "" {
					call.ID = util.NewToolCallID()
				}
				existing, ok := callsByID[call.ID]
				if !ok {
					callsByID[call.ID] = call
					callOrder = append(callOrder, call.ID)
					continue
				}
				if call.Name != "" {
					existing.Name = call.Name
				}
				if len(call.Input) > 0 && string(call.Input) != "{}" {
					existing.Input = call.Input
				}
				callsByID[call.ID] = existing
			}
		case aikit.StreamChunkMessageEnd:
			_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
				TS:        time.Now().UTC(),
				SessionID: sessionID,
				TurnID:    turnID,
				Type:      "model_output_completed",
				Data: map[string]any{
					"finish_reason": chunk.FinishReason,
				},
			})
		case aikit.StreamChunkError:
			if chunk.Error != nil {
				return "", nil, fmt.Errorf("model error: %s", chunk.Error.Message)
			}
		}
	}
	calls := make([]ToolCall, 0, len(callOrder))
	for _, id := range callOrder {
		calls = append(calls, callsByID[id])
	}
	return assistant.String(), calls, nil
}

func (r *SessionRunner) invokeVerify(ctx context.Context, sessionID, turnID string, toolRegistry ToolRegistry) (runstore.Message, error) {
	verifyCall := ToolCall{
		ID:    util.NewToolCallID(),
		Name:  "verify",
		Input: json.RawMessage("{}"),
	}
	tool, ok := toolRegistry.Get("verify")
	if !ok {
		return runstore.Message{}, errors.New("verify tool not configured")
	}
	if r.requiresApproval(tool.Definition()) {
		if _, err := r.Store.RequireSessionApproval(sessionID, verifyCall.ID); err != nil {
			return runstore.Message{}, err
		}
		_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
			TS:        time.Now().UTC(),
			SessionID: sessionID,
			TurnID:    turnID,
			Type:      "approval_requested",
			Data: map[string]any{
				"tool":         "verify",
				"tool_call_id": verifyCall.ID,
			},
		})
		decision, err := r.Store.WaitForSessionApproval(ctx, sessionID, verifyCall.ID)
		if err != nil {
			return runstore.Message{}, err
		}
		if decision.Action == "deny" {
			return runstore.Message{}, errors.New("verification denied")
		}
	}

	_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: sessionID,
		TurnID:    turnID,
		Type:      "tool_call_started",
		Data: map[string]any{
			"tool":         "verify",
			"tool_call_id": verifyCall.ID,
		},
	})
	result, err := tool.Invoke(ctx, verifyCall)
	if err != nil {
		result.OK = false
		result.Error = err.Error()
	}
	_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: sessionID,
		TurnID:    turnID,
		Type:      "tool_call_completed",
		Data: map[string]any{
			"tool":         "verify",
			"tool_call_id": verifyCall.ID,
			"ok":           result.OK,
			"error":        result.Error,
		},
	})
	msg := runstore.Message{
		ID:         util.NewMessageID(),
		Role:       "tool",
		ToolCallID: verifyCall.ID,
		Parts:      result.Parts,
		CreatedAt:  time.Now().UTC(),
	}
	if _, err := r.Store.AppendMessage(sessionID, msg); err != nil {
		return msg, err
	}
	_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: sessionID,
		TurnID:    turnID,
		Type:      "message_added",
		Data: map[string]any{
			"message_id": msg.ID,
			"role":       msg.Role,
		},
	})
	if !result.OK {
		return msg, errors.New("verification failed")
	}
	return msg, nil
}

func (r *SessionRunner) invokeSpecValidate(ctx context.Context, sessionID, turnID string, toolRegistry ToolRegistry) (runstore.Message, error) {
	validateCall := ToolCall{
		ID:    util.NewToolCallID(),
		Name:  "validate_spec",
		Input: json.RawMessage("{}"),
	}
	tool, ok := toolRegistry.Get("validate_spec")
	if !ok {
		return runstore.Message{}, errors.New("validate_spec tool not configured")
	}

	_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: sessionID,
		TurnID:    turnID,
		Type:      "tool_call_started",
		Data: map[string]any{
			"tool":         "validate_spec",
			"tool_call_id": validateCall.ID,
		},
	})
	result, err := tool.Invoke(ctx, validateCall)
	if err != nil {
		result.OK = false
		result.Error = err.Error()
	}
	_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: sessionID,
		TurnID:    turnID,
		Type:      "tool_call_completed",
		Data: map[string]any{
			"tool":         "validate_spec",
			"tool_call_id": validateCall.ID,
			"ok":           result.OK,
			"error":        result.Error,
		},
	})
	_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: sessionID,
		TurnID:    turnID,
		Type:      "spec_validated",
		Data: map[string]any{
			"ok":    result.OK,
			"error": result.Error,
		},
	})

	msg := runstore.Message{
		ID:         util.NewMessageID(),
		Role:       "tool",
		ToolCallID: validateCall.ID,
		Parts:      result.Parts,
		CreatedAt:  time.Now().UTC(),
	}
	if _, err := r.Store.AppendMessage(sessionID, msg); err != nil {
		return msg, err
	}
	_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: sessionID,
		TurnID:    turnID,
		Type:      "message_added",
		Data: map[string]any{
			"message_id": msg.ID,
			"role":       msg.Role,
		},
	})

	if !result.OK {
		return msg, errors.New("spec validation failed")
	}
	return msg, nil
}

func (r *SessionRunner) requiresApproval(def ToolDefinition) bool {
	if def.AllowWithoutApproval {
		return false
	}
	if def.RequiresApproval {
		return true
	}
	for _, kind := range r.ApprovalPolicy.RequireForKinds {
		if def.Kind == kind {
			return true
		}
	}
	for _, name := range r.ApprovalPolicy.RequireForTools {
		if def.Name == name {
			return true
		}
	}
	return false
}

func (r *SessionRunner) failTurn(sessionID, turnID string, err error) error {
	session, getErr := r.Store.GetSession(sessionID)
	if getErr != nil {
		return err
	}
	session.Status = runstore.SessionFailed
	session.Error = err.Error()
	for i := range session.Turns {
		if session.Turns[i].ID == turnID {
			now := time.Now().UTC()
			session.Turns[i].Status = runstore.TurnFailed
			session.Turns[i].CompletedAt = &now
			session.Turns[i].Error = err.Error()
		}
	}
	_ = r.Store.UpdateSession(session)
	_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: sessionID,
		TurnID:    turnID,
		Type:      "turn_failed",
		Message:   err.Error(),
	})
	return err
}

func (r *SessionRunner) cancelTurn(sessionID, turnID string, err error) error {
	session, getErr := r.Store.GetSession(sessionID)
	if getErr != nil {
		return err
	}
	session.Status = runstore.SessionCanceled
	session.Error = err.Error()
	for i := range session.Turns {
		if session.Turns[i].ID == turnID {
			now := time.Now().UTC()
			session.Turns[i].Status = runstore.TurnFailed
			session.Turns[i].CompletedAt = &now
			session.Turns[i].Error = err.Error()
		}
	}
	_ = r.Store.UpdateSession(session)
	_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: sessionID,
		TurnID:    turnID,
		Type:      "session_canceled",
		Message:   err.Error(),
	})
	return err
}

func (r *SessionRunner) completeTurn(sessionID, turnID string) error {
	session, getErr := r.Store.GetSession(sessionID)
	if getErr != nil {
		return getErr
	}
	session.Status = runstore.SessionActive
	session.Error = ""
	for i := range session.Turns {
		if session.Turns[i].ID == turnID {
			now := time.Now().UTC()
			session.Turns[i].Status = runstore.TurnSucceeded
			session.Turns[i].CompletedAt = &now
		}
	}
	_ = r.Store.UpdateSession(session)
	_ = r.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: sessionID,
		TurnID:    turnID,
		Type:      "turn_completed",
	})
	return nil
}
