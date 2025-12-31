package api

import (
	"context"
	"encoding/json"
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

type dummySessionRunner struct{}

func (d dummySessionRunner) StartTurn(ctx context.Context, sessionID, turnID string) error {
	return nil
}

type dummySpecGen struct{}

func (d dummySpecGen) GenerateSpec(ctx context.Context, workspacePath, specName, prompt string) (string, error) {
	return "# spec\n", nil
}

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

func TestServer_CreateSession(t *testing.T) {
	tmp := t.TempDir()
	store := runstore.New(tmp)
	if err := store.Init(); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := &Server{
		Logger:        logger,
		Store:         store,
		SessionRunner: dummySessionRunner{},
		AuthToken:     "",
	}
	h := s.Handler()

	ws := filepath.Join(tmp, "ws")
	_ = os.MkdirAll(ws, 0o755)

	req := httptest.NewRequest("POST", "/v1/sessions", strings.NewReader(`{"workspace_path":"`+ws+`"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestServer_CreateSession_SpecModeDefaultPath(t *testing.T) {
	tmp := t.TempDir()
	store := runstore.New(tmp)
	if err := store.Init(); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := &Server{
		Logger:        logger,
		Store:         store,
		SessionRunner: dummySessionRunner{},
		AuthToken:     "",
	}
	h := s.Handler()

	ws := filepath.Join(tmp, "ws")
	_ = os.MkdirAll(ws, 0o755)

	req := httptest.NewRequest("POST", "/v1/sessions", strings.NewReader(`{"workspace_path":"`+ws+`","mode":"spec"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp CreateSessionResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if strings.TrimSpace(resp.SpecPath) == "" {
		t.Fatalf("expected spec_path in response")
	}
	if _, err := os.Stat(resp.SpecPath); err != nil {
		t.Fatalf("expected spec file: %v", err)
	}
}

func TestServer_GenerateSpec(t *testing.T) {
	tmp := t.TempDir()
	store := runstore.New(tmp)
	if err := store.Init(); err != nil {
		t.Fatal(err)
	}

	ws := filepath.Join(tmp, "ws")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := &Server{
		Logger:  logger,
		Store:   store,
		SpecGen: dummySpecGen{},
	}
	h := s.Handler()

	req := httptest.NewRequest("POST", "/v1/specs/generate", strings.NewReader(`{"workspace_path":"`+ws+`","spec_name":"my-spec","prompt":"do thing"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(ws, "specs", "my-spec", "spec.md")); err != nil {
		t.Fatalf("expected spec file: %v", err)
	}
}
