package api

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yourorg/coding-agent-harness/internal/runstore"
)

type dummyRunner struct{}

func (d dummyRunner) StartRun(ctx context.Context, runID string) error { return nil }

func TestServer_CreateRun(t *testing.T) {
	tmp := t.TempDir()
	store := runstore.New(tmp)
	if err := store.Init(); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := &Server{
		Logger:    logger,
		Store:     store,
		Runner:    dummyRunner{},
		AuthToken: "",
	}
	h := s.Handler()

	ws := filepath.Join(tmp, "ws")
	spec := filepath.Join(tmp, "spec.md")
	_ = os.MkdirAll(ws, 0o755)
	_ = os.WriteFile(spec, []byte("# spec"), 0o644)

	req := httptest.NewRequest("POST", "/v1/runs", strings.NewReader(`{"workspace_path":"`+ws+`","spec_path":"`+spec+`"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}
