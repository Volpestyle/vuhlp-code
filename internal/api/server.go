package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/yourorg/coding-agent-harness/internal/runstore"
	"github.com/yourorg/coding-agent-harness/internal/util"
)

type RunStarter interface {
	StartRun(ctx context.Context, runID string) error
}

type Server struct {
	Logger    *slog.Logger
	Store     *runstore.Store
	Runner    RunStarter
	AuthToken string
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
