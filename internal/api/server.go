package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	aikit "github.com/Volpestyle/ai-kit/packages/go"
	"github.com/yourorg/coding-agent-harness/internal/config"
	"github.com/yourorg/coding-agent-harness/internal/runstore"
	"github.com/yourorg/coding-agent-harness/internal/util"
)

type RunStarter interface {
	StartRun(ctx context.Context, runID string) error
}

type SessionTurnStarter interface {
	StartTurn(ctx context.Context, sessionID, turnID string) error
}

type SpecGenerator interface {
	GenerateSpec(ctx context.Context, workspacePath, specName, prompt string) (string, error)
}

type ModelService interface {
	ListModels(ctx context.Context) ([]aikit.ModelRecord, error)
	GetPolicy() config.ModelPolicy
	SetPolicy(policy config.ModelPolicy) error
}

type Server struct {
	Logger        *slog.Logger
	Store         *runstore.Store
	Runner        RunStarter
	SessionRunner SessionTurnStarter
	SpecGen       SpecGenerator
	ModelSvc      ModelService
	AuthToken     string
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/", s.handleDashboard)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		util.WriteJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("/hello", func(w http.ResponseWriter, r *http.Request) {
		util.WriteJSON(w, 200, map[string]any{"message": "hello"})
	})

	mux.HandleFunc("/v1/runs", s.handleRuns)
	mux.HandleFunc("/v1/runs/", s.handleRun)
	mux.HandleFunc("/v1/sessions", s.handleSessions)
	mux.HandleFunc("/v1/sessions/", s.handleSession)
	mux.HandleFunc("/v1/specs/generate", s.handleSpecGenerate)
	mux.HandleFunc("/v1/models", s.handleModels)
	mux.HandleFunc("/v1/model-policy", s.handleModelPolicy)

	var h http.Handler = mux
	h = CORSMiddleware()(h)
	h = AuthMiddleware(s.AuthToken)(h)
	h = LoggingMiddleware(s.Logger)(h)
	h = RecoverMiddleware(s.Logger)(h)
	return h
}

func (s *Server) handleRuns(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		runs, err := s.Store.ListRuns()
		if err != nil {
			util.WriteError(w, 500, err.Error())
			return
		}
		util.WriteJSON(w, 200, runs)
	case http.MethodPost:
		var req CreateRunRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			util.WriteError(w, 400, "invalid json")
			return
		}
		run, err := s.Store.CreateRun(req.WorkspacePath, req.SpecPath)
		if err != nil {
			util.WriteError(w, 400, err.Error())
			return
		}
		// Start async.
		if s.Runner != nil {
			_ = s.Runner.StartRun(r.Context(), run.ID)
		}
		util.WriteJSON(w, 200, CreateRunResponse{RunID: run.ID})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	// path: /v1/runs/{runID}[/...]
	rest := strings.TrimPrefix(r.URL.Path, "/v1/runs/")
	parts := strings.Split(rest, "/")
	if len(parts) == 0 || parts[0] == "" {
		util.WriteError(w, 404, "run id required")
		return
	}
	runID := parts[0]
	if len(parts) == 1 || parts[1] == "" {
		// /v1/runs/{id}
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		run, err := s.Store.GetRun(runID)
		if err != nil {
			util.WriteError(w, 404, err.Error())
			return
		}
		util.WriteJSON(w, 200, run)
		return
	}

	switch parts[1] {
	case "events":
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		s.handleRunEvents(w, r, runID)
	case "approve":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var req ApproveRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.StepID) == "" {
			util.WriteError(w, 400, "step_id required")
			return
		}
		if err := s.Store.Approve(runID, req.StepID); err != nil {
			util.WriteError(w, 400, err.Error())
			return
		}
		_ = s.Store.AppendEvent(runID, runstore.Event{
			TS:    time.Now().UTC(),
			RunID: runID,
			Type:  "approval_granted",
			Data: map[string]any{
				"step_id": req.StepID,
			},
		})
		util.WriteJSON(w, 200, map[string]any{"ok": true})
	case "cancel":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		s.Store.CancelRun(runID)
		_ = s.Store.AppendEvent(runID, runstore.Event{
			TS:    time.Now().UTC(),
			RunID: runID,
			Type:  "run_cancel_requested",
		})
		util.WriteJSON(w, 200, map[string]any{"ok": true})
	case "export":
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s.zip\"", runID))
		if err := s.Store.ExportRun(runID, w); err != nil {
			util.WriteError(w, 500, err.Error())
			return
		}
	default:
		util.WriteError(w, 404, "unknown endpoint")
	}
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		sessions, err := s.Store.ListSessions()
		if err != nil {
			util.WriteError(w, 500, err.Error())
			return
		}
		util.WriteJSON(w, 200, sessions)
	case http.MethodPost:
		var req CreateSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			util.WriteError(w, 400, "invalid json")
			return
		}
		mode := strings.TrimSpace(req.Mode)
		if mode == "" {
			mode = string(runstore.SessionModeChat)
		}
		specPath := strings.TrimSpace(req.SpecPath)
		if mode == string(runstore.SessionModeSpec) {
			if specPath != "" {
				specAbs, err := resolveSpecPath(req.WorkspacePath, specPath)
				if err != nil {
					util.WriteError(w, 400, err.Error())
					return
				}
				specPath = specAbs
			}
		} else if specPath != "" {
			specAbs, err := resolveSpecPath(req.WorkspacePath, specPath)
			if err != nil {
				util.WriteError(w, 400, err.Error())
				return
			}
			specPath = specAbs
		}

		session, err := s.Store.CreateSession(req.WorkspacePath, req.SystemPrompt, mode, specPath)
		if err != nil {
			util.WriteError(w, 400, err.Error())
			return
		}
		if session.Mode == runstore.SessionModeSpec && strings.TrimSpace(session.SpecPath) == "" {
			defaultPath, err := util.DefaultSpecPath(session.WorkspacePath, "session-"+session.ID)
			if err != nil {
				util.WriteError(w, 500, err.Error())
				return
			}
			session.SpecPath = defaultPath
			if err := s.Store.UpdateSession(session); err != nil {
				util.WriteError(w, 500, err.Error())
				return
			}
			_ = s.Store.AppendSessionEvent(session.ID, runstore.SessionEvent{
				TS:        time.Now().UTC(),
				SessionID: session.ID,
				Type:      "spec_path_set",
				Data: map[string]any{
					"spec_path": session.SpecPath,
				},
			})
			created, err := util.EnsureSpecFile(session.SpecPath)
			if err != nil {
				util.WriteError(w, 500, err.Error())
				return
			}
			if created {
				_ = s.Store.AppendSessionEvent(session.ID, runstore.SessionEvent{
					TS:        time.Now().UTC(),
					SessionID: session.ID,
					Type:      "spec_created",
					Data: map[string]any{
						"spec_path": session.SpecPath,
					},
				})
			}
		}
		util.WriteJSON(w, 200, CreateSessionResponse{SessionID: session.ID, SpecPath: session.SpecPath})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	// path: /v1/sessions/{sessionID}[/...]
	rest := strings.TrimPrefix(r.URL.Path, "/v1/sessions/")
	parts := strings.Split(rest, "/")
	if len(parts) == 0 || parts[0] == "" {
		util.WriteError(w, 404, "session id required")
		return
	}
	sessionID := parts[0]
	if len(parts) == 1 || parts[1] == "" {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		session, err := s.Store.GetSession(sessionID)
		if err != nil {
			util.WriteError(w, 404, err.Error())
			return
		}
		util.WriteJSON(w, 200, session)
		return
	}

	switch parts[1] {
	case "mode":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var req UpdateSessionModeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			util.WriteError(w, 400, "invalid json")
			return
		}
		mode := strings.TrimSpace(req.Mode)
		if mode == "" {
			util.WriteError(w, 400, "mode is required")
			return
		}
		if mode != string(runstore.SessionModeChat) && mode != string(runstore.SessionModeSpec) {
			util.WriteError(w, 400, "mode must be chat or spec")
			return
		}
		session, err := s.Store.GetSession(sessionID)
		if err != nil {
			util.WriteError(w, 404, err.Error())
			return
		}
		specPath := strings.TrimSpace(req.SpecPath)
		if mode == string(runstore.SessionModeSpec) {
			if specPath != "" {
				specAbs, err := resolveSpecPath(session.WorkspacePath, specPath)
				if err != nil {
					util.WriteError(w, 400, err.Error())
					return
				}
				specPath = specAbs
			} else if strings.TrimSpace(session.SpecPath) == "" {
				defaultPath, err := util.DefaultSpecPath(session.WorkspacePath, "session-"+session.ID)
				if err != nil {
					util.WriteError(w, 500, err.Error())
					return
				}
				specPath = defaultPath
			} else {
				specPath = session.SpecPath
			}
		} else if specPath != "" {
			specAbs, err := resolveSpecPath(session.WorkspacePath, specPath)
			if err != nil {
				util.WriteError(w, 400, err.Error())
				return
			}
			specPath = specAbs
		}
		session.Mode = runstore.SessionMode(mode)
		if strings.TrimSpace(specPath) != "" {
			session.SpecPath = specPath
		}
		if err := s.Store.UpdateSession(session); err != nil {
			util.WriteError(w, 500, err.Error())
			return
		}
		_ = s.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
			TS:        time.Now().UTC(),
			SessionID: sessionID,
			Type:      "session_mode_set",
			Data: map[string]any{
				"mode":      session.Mode,
				"spec_path": session.SpecPath,
			},
		})
		if session.Mode == runstore.SessionModeSpec && strings.TrimSpace(session.SpecPath) != "" {
			created, err := util.EnsureSpecFile(session.SpecPath)
			if err != nil {
				util.WriteError(w, 500, err.Error())
				return
			}
			if created {
				_ = s.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
					TS:        time.Now().UTC(),
					SessionID: sessionID,
					Type:      "spec_created",
					Data: map[string]any{
						"spec_path": session.SpecPath,
					},
				})
			}
		}
		util.WriteJSON(w, 200, UpdateSessionModeResponse{
			SessionID: session.ID,
			Mode:      string(session.Mode),
			SpecPath:  session.SpecPath,
		})
	case "events":
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		s.handleSessionEvents(w, r, sessionID)
	case "messages":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		s.handleSessionMessage(w, r, sessionID)
	case "approve":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var req SessionApproveRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.ToolCallID) == "" {
			util.WriteError(w, 400, "tool_call_id required")
			return
		}
		if strings.TrimSpace(req.Action) == "" {
			req.Action = "approve"
		}
		if err := s.Store.ApproveSessionToolCall(sessionID, req.ToolCallID, runstore.ApprovalDecision{
			Action: req.Action,
			Reason: req.Reason,
		}); err != nil {
			util.WriteError(w, 400, err.Error())
			return
		}
		evType := "approval_granted"
		if req.Action == "deny" {
			evType = "approval_denied"
		}
		_ = s.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
			TS:        time.Now().UTC(),
			SessionID: sessionID,
			TurnID:    req.TurnID,
			Type:      evType,
			Data: map[string]any{
				"tool_call_id": req.ToolCallID,
				"reason":       req.Reason,
			},
		})
		util.WriteJSON(w, 200, map[string]any{"ok": true})
	case "cancel":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		s.Store.CancelSession(sessionID)
		_ = s.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
			TS:        time.Now().UTC(),
			SessionID: sessionID,
			Type:      "session_canceled",
		})
		util.WriteJSON(w, 200, map[string]any{"ok": true})
	case "attachments":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		s.handleSessionAttachment(w, r, sessionID)
	case "turns":
		if len(parts) < 4 || parts[3] != "retry" {
			util.WriteError(w, 404, "unknown endpoint")
			return
		}
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		turnID := parts[2]
		if s.SessionRunner == nil {
			util.WriteError(w, 500, "session runner not configured")
			return
		}
		if err := s.SessionRunner.StartTurn(r.Context(), sessionID, turnID); err != nil {
			util.WriteError(w, 500, err.Error())
			return
		}
		util.WriteJSON(w, 200, map[string]any{"ok": true})
	default:
		util.WriteError(w, 404, "unknown endpoint")
	}
}

func (s *Server) handleSessionMessage(w http.ResponseWriter, r *http.Request, sessionID string) {
	var req AddMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		util.WriteError(w, 400, "invalid json")
		return
	}
	role := strings.TrimSpace(req.Role)
	if role == "" {
		util.WriteError(w, 400, "role required")
		return
	}
	parts := make([]runstore.MessagePart, 0, len(req.Parts))
	for _, part := range req.Parts {
		parts = append(parts, runstore.MessagePart{
			Type:     part.Type,
			Text:     part.Text,
			Ref:      part.Ref,
			MimeType: part.MimeType,
		})
	}
	msg := runstore.Message{
		ID:        util.NewMessageID(),
		Role:      role,
		Parts:     parts,
		CreatedAt: time.Now().UTC(),
	}
	if _, err := s.Store.AppendMessage(sessionID, msg); err != nil {
		util.WriteError(w, 400, err.Error())
		return
	}
	_ = s.Store.AppendSessionEvent(sessionID, runstore.SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: sessionID,
		Type:      "message_added",
		Data: map[string]any{
			"message_id": msg.ID,
			"role":       msg.Role,
		},
	})

	turnID, err := s.Store.AddTurn(sessionID)
	if err != nil {
		util.WriteError(w, 500, err.Error())
		return
	}

	if req.AutoRun {
		if s.SessionRunner == nil {
			util.WriteError(w, 500, "session runner not configured")
			return
		}
		if err := s.SessionRunner.StartTurn(r.Context(), sessionID, turnID); err != nil {
			util.WriteError(w, 500, err.Error())
			return
		}
	}

	util.WriteJSON(w, 200, AddMessageResponse{
		MessageID: msg.ID,
		TurnID:    turnID,
	})
}

func (s *Server) handleSessionAttachment(w http.ResponseWriter, r *http.Request, sessionID string) {
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(25 << 20); err != nil {
			util.WriteError(w, 400, "invalid multipart form")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			util.WriteError(w, 400, "file required")
			return
		}
		defer file.Close()

		content, err := io.ReadAll(file)
		if err != nil {
			util.WriteError(w, 500, err.Error())
			return
		}
		ref, mimeType, err := s.Store.SaveSessionAttachment(sessionID, header.Filename, header.Header.Get("Content-Type"), content)
		if err != nil {
			util.WriteError(w, 500, err.Error())
			return
		}
		util.WriteJSON(w, 200, AttachmentUploadResponse{Ref: ref, MimeType: mimeType})
		return
	}

	var req AttachmentUploadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		util.WriteError(w, 400, "invalid json")
		return
	}
	if strings.TrimSpace(req.ContentBase64) == "" {
		util.WriteError(w, 400, "content_base64 required")
		return
	}
	content, err := base64.StdEncoding.DecodeString(req.ContentBase64)
	if err != nil {
		util.WriteError(w, 400, "invalid base64 content")
		return
	}
	ref, mimeType, err := s.Store.SaveSessionAttachment(sessionID, req.Name, req.MimeType, content)
	if err != nil {
		util.WriteError(w, 500, err.Error())
		return
	}
	util.WriteJSON(w, 200, AttachmentUploadResponse{Ref: ref, MimeType: mimeType})
}

func (s *Server) handleSessionEvents(w http.ResponseWriter, r *http.Request, sessionID string) {
	if r.URL.Query().Get("format") == "json" {
		max := 0
		if raw := r.URL.Query().Get("max"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 0 {
				max = parsed
			}
		}
		history, err := s.Store.ReadSessionEvents(sessionID, max)
		if err != nil {
			util.WriteError(w, 500, err.Error())
			return
		}
		util.WriteJSON(w, 200, history)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		util.WriteError(w, 500, "streaming not supported")
		return
	}

	history, _ := s.Store.ReadSessionEvents(sessionID, 200)
	for _, ev := range history {
		_ = writeSSE(w, "message", ev)
	}
	flusher.Flush()

	ch, cancel := s.Store.SubscribeSession(sessionID)
	defer cancel()

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-ch:
			_ = writeSSE(w, "message", ev)
			flusher.Flush()
		case <-ticker.C:
			_, _ = io.WriteString(w, ": keep-alive\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) handleSpecGenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if s.SpecGen == nil {
		util.WriteError(w, 500, "spec generator not configured")
		return
	}
	var req GenerateSpecRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		util.WriteError(w, 400, "invalid json")
		return
	}
	workspace := strings.TrimSpace(req.WorkspacePath)
	specName := strings.TrimSpace(req.SpecName)
	prompt := strings.TrimSpace(req.Prompt)
	if workspace == "" || specName == "" || prompt == "" {
		util.WriteError(w, 400, "workspace_path, spec_name, and prompt are required")
		return
	}
	if !isSafeSpecName(specName) {
		util.WriteError(w, 400, "spec_name must be alphanumeric with dashes or underscores")
		return
	}
	if info, err := os.Stat(workspace); err != nil || !info.IsDir() {
		util.WriteError(w, 400, "workspace_path must be a directory")
		return
	}
	specRel := filepath.ToSlash(filepath.Join("specs", specName, "spec.md"))
	specAbs, err := safeWorkspaceJoin(workspace, specRel)
	if err != nil {
		util.WriteError(w, 400, err.Error())
		return
	}
	if !req.Overwrite {
		if _, err := os.Stat(specAbs); err == nil {
			util.WriteError(w, 409, "spec already exists")
			return
		}
	}

	content, err := s.SpecGen.GenerateSpec(r.Context(), workspace, specName, prompt)
	if err != nil {
		util.WriteError(w, 500, err.Error())
		return
	}
	if err := os.MkdirAll(filepath.Dir(specAbs), 0o755); err != nil {
		util.WriteError(w, 500, err.Error())
		return
	}
	diagDir := filepath.Join(filepath.Dir(specAbs), "diagrams")
	if err := os.MkdirAll(diagDir, 0o755); err != nil {
		util.WriteError(w, 500, err.Error())
		return
	}
	if err := os.WriteFile(specAbs, []byte(content), 0o644); err != nil {
		util.WriteError(w, 500, err.Error())
		return
	}
	util.WriteJSON(w, 200, GenerateSpecResponse{
		SpecPath: specAbs,
		Content:  content,
	})
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if s.ModelSvc == nil {
		util.WriteError(w, 500, "model service not configured")
		return
	}
	models, err := s.ModelSvc.ListModels(r.Context())
	if err != nil {
		util.WriteError(w, 500, err.Error())
		return
	}
	util.WriteJSON(w, 200, map[string]any{
		"models": models,
		"policy": s.ModelSvc.GetPolicy(),
	})
}

func (s *Server) handleModelPolicy(w http.ResponseWriter, r *http.Request) {
	if s.ModelSvc == nil {
		util.WriteError(w, 500, "model service not configured")
		return
	}
	switch r.Method {
	case http.MethodGet:
		util.WriteJSON(w, 200, s.ModelSvc.GetPolicy())
	case http.MethodPost:
		var policy config.ModelPolicy
		if err := json.NewDecoder(r.Body).Decode(&policy); err != nil {
			util.WriteError(w, 400, "invalid json")
			return
		}
		if err := s.ModelSvc.SetPolicy(policy); err != nil {
			util.WriteError(w, 500, err.Error())
			return
		}
		util.WriteJSON(w, 200, s.ModelSvc.GetPolicy())
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func isSafeSpecName(name string) bool {
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return false
		}
	}
	return name != ""
}

func safeWorkspaceJoin(workspace, rel string) (string, error) {
	workspace = filepath.Clean(workspace)
	abs := filepath.Clean(filepath.Join(workspace, rel))
	relPath, err := filepath.Rel(workspace, abs)
	if err != nil {
		return "", err
	}
	if relPath == ".." || strings.HasPrefix(relPath, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("path escapes workspace: %s", rel)
	}
	return abs, nil
}

func resolveSpecPath(workspace, specPath string) (string, error) {
	if strings.TrimSpace(specPath) == "" {
		return "", errors.New("spec_path is empty")
	}
	workspace = filepath.Clean(workspace)
	if filepath.IsAbs(specPath) {
		abs := filepath.Clean(specPath)
		relPath, err := filepath.Rel(workspace, abs)
		if err != nil {
			return "", err
		}
		if relPath == ".." || strings.HasPrefix(relPath, ".."+string(os.PathSeparator)) {
			return "", fmt.Errorf("spec_path escapes workspace: %s", specPath)
		}
		return abs, nil
	}
	return safeWorkspaceJoin(workspace, specPath)
}

func (s *Server) handleRunEvents(w http.ResponseWriter, r *http.Request, runID string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		util.WriteError(w, 500, "streaming not supported")
		return
	}

	// Replay some history so attach shows context.
	history, _ := s.Store.ReadEvents(runID, 200)
	for _, ev := range history {
		_ = writeSSE(w, "message", ev)
	}
	flusher.Flush()

	ch, cancel := s.Store.Subscribe(runID)
	defer cancel()

	// Keep-alive.
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-ch:
			_ = writeSSE(w, "message", ev)
			flusher.Flush()
		case <-ticker.C:
			_, _ = io.WriteString(w, ": keep-alive\n\n")
			flusher.Flush()
		}
	}
}

func writeSSE(w io.Writer, event string, data any) error {
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
		return err
	}
	return nil
}
