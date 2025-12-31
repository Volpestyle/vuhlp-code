package runstore

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/yourorg/coding-agent-harness/internal/util"
)

type Store struct {
	dataDir string

	mu   sync.RWMutex
	runs map[string]*Run

	subsMu sync.Mutex
	subs   map[string]map[chan Event]struct{}

	approvalMu sync.Mutex
	approvals  map[string]map[string]chan struct{} // runID -> stepID -> ch

	cancelMu sync.Mutex
	cancels  map[string]context.CancelFunc
}

func New(dataDir string) *Store {
	return &Store{
		dataDir:   util.ExpandHome(dataDir),
		runs:      map[string]*Run{},
		subs:      map[string]map[chan Event]struct{}{},
		approvals: map[string]map[string]chan struct{}{},
		cancels:   map[string]context.CancelFunc{},
	}
}

func (s *Store) Init() error {
	if s.dataDir == "" {
		return errors.New("dataDir is empty")
	}
	if err := os.MkdirAll(filepath.Join(s.dataDir, "runs"), 0o755); err != nil {
		return err
	}
	return s.loadExisting()
}

func (s *Store) loadExisting() error {
	runsDir := filepath.Join(s.dataDir, "runs")
	entries, err := os.ReadDir(runsDir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		runID := e.Name()
		runPath := filepath.Join(runsDir, runID, "run.json")
		b, err := os.ReadFile(runPath)
		if err != nil {
			continue
		}
		var run Run
		if err := json.Unmarshal(b, &run); err != nil {
			continue
		}
		s.mu.Lock()
		s.runs[run.ID] = &run
		s.mu.Unlock()
	}
	return nil
}

func (s *Store) DataDir() string { return s.dataDir }

func (s *Store) runDir(runID string) string {
	return filepath.Join(s.dataDir, "runs", runID)
}

func (s *Store) runPath(runID string) string {
	return filepath.Join(s.runDir(runID), "run.json")
}

func (s *Store) eventsPath(runID string) string {
	return filepath.Join(s.runDir(runID), "events.ndjson")
}

func (s *Store) CreateRun(workspacePath, specPath string) (*Run, error) {
	if strings.TrimSpace(workspacePath) == "" {
		return nil, errors.New("workspacePath is empty")
	}
	if strings.TrimSpace(specPath) == "" {
		return nil, errors.New("specPath is empty")
	}
	run := &Run{
		ID:            util.NewRunID(),
		CreatedAt:     time.Now().UTC(),
		UpdatedAt:     time.Now().UTC(),
		Status:        RunQueued,
		WorkspacePath: workspacePath,
		SpecPath:      specPath,
	}
	dir := s.runDir(run.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	// Create empty event log.
	if err := os.WriteFile(s.eventsPath(run.ID), []byte{}, 0o644); err != nil {
		return nil, err
	}

	if err := s.saveRun(run); err != nil {
		return nil, err
	}

	s.mu.Lock()
	s.runs[run.ID] = run
	s.mu.Unlock()

	_ = s.AppendEvent(run.ID, Event{
		TS:    time.Now().UTC(),
		RunID: run.ID,
		Type:  "run_created",
		Data: map[string]any{
			"workspace_path": workspacePath,
			"spec_path":      specPath,
		},
	})

	return run, nil
}

func (s *Store) saveRun(run *Run) error {
	run.UpdatedAt = time.Now().UTC()
	b, err := json.MarshalIndent(run, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.runPath(run.ID), append(b, '\n'), 0o644)
}

func (s *Store) UpdateRun(run *Run) error {
	if run == nil {
		return errors.New("run is nil")
	}
	s.mu.Lock()
	s.runs[run.ID] = run
	s.mu.Unlock()
	return s.saveRun(run)
}

func (s *Store) GetRun(runID string) (*Run, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.runs[runID]
	if !ok {
		return nil, fmt.Errorf("run not found: %s", runID)
	}
	cp := *r
	return &cp, nil
}

func (s *Store) ListRuns() ([]Run, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Run, 0, len(s.runs))
	for _, r := range s.runs {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out, nil
}

func (s *Store) AppendEvent(runID string, ev Event) error {
	ev.TS = ev.TS.UTC()
	if ev.RunID == "" {
		ev.RunID = runID
	}

	f, err := os.OpenFile(s.eventsPath(runID), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()

	line, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		return err
	}

	// Broadcast.
	s.subsMu.Lock()
	defer s.subsMu.Unlock()
	for ch := range s.subs[runID] {
		select {
		case ch <- ev:
		default:
			// Drop if subscriber is slow.
		}
	}
	return nil
}

func (s *Store) Subscribe(runID string) (<-chan Event, func()) {
	ch := make(chan Event, 256)
	s.subsMu.Lock()
	if s.subs[runID] == nil {
		s.subs[runID] = map[chan Event]struct{}{}
	}
	s.subs[runID][ch] = struct{}{}
	s.subsMu.Unlock()

	cancel := func() {
		s.subsMu.Lock()
		if m := s.subs[runID]; m != nil {
			delete(m, ch)
		}
		s.subsMu.Unlock()
		close(ch)
	}
	return ch, cancel
}

// ReadEvents reads up to max events from the NDJSON log (0 => all).
func (s *Store) ReadEvents(runID string, max int) ([]Event, error) {
	f, err := os.Open(s.eventsPath(runID))
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var out []Event
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var ev Event
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			continue
		}
		out = append(out, ev)
		if max > 0 && len(out) >= max {
			break
		}
	}
	if err := sc.Err(); err != nil {
		return out, err
	}
	return out, nil
}

func (s *Store) RequireApproval(runID, stepID string) (<-chan struct{}, error) {
	if runID == "" || stepID == "" {
		return nil, errors.New("runID and stepID required")
	}
	s.approvalMu.Lock()
	defer s.approvalMu.Unlock()
	if s.approvals[runID] == nil {
		s.approvals[runID] = map[string]chan struct{}{}
	}
	if _, ok := s.approvals[runID][stepID]; ok {
		return nil, fmt.Errorf("approval already pending for step %s", stepID)
	}
	ch := make(chan struct{})
	s.approvals[runID][stepID] = ch
	return ch, nil
}

func (s *Store) Approve(runID, stepID string) error {
	s.approvalMu.Lock()
	defer s.approvalMu.Unlock()
	m := s.approvals[runID]
	if m == nil {
		return fmt.Errorf("no approvals pending for run %s", runID)
	}
	ch, ok := m[stepID]
	if !ok {
		return fmt.Errorf("no approval pending for step %s", stepID)
	}
	close(ch)
	delete(m, stepID)
	return nil
}

func (s *Store) WaitForApproval(ctx context.Context, runID, stepID string) error {
	s.approvalMu.Lock()
	ch := s.approvals[runID][stepID]
	s.approvalMu.Unlock()

	if ch == nil {
		return fmt.Errorf("no approval pending for step %s", stepID)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-ch:
		return nil
	}
}

// Cancellation helpers

func (s *Store) SetRunCancel(runID string, cancel context.CancelFunc) {
	s.cancelMu.Lock()
	defer s.cancelMu.Unlock()
	s.cancels[runID] = cancel
}

func (s *Store) CancelRun(runID string) {
	s.cancelMu.Lock()
	cancel := s.cancels[runID]
	s.cancelMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// ExportRun zips run.json + events.ndjson + artifacts/ (if present).
func (s *Store) ExportRun(runID string, w io.Writer) error {
	dir := s.runDir(runID)
	if _, err := os.Stat(dir); err != nil {
		return err
	}
	zw := NewZipWriter(w)
	defer zw.Close()

	files := []string{
		s.runPath(runID),
		s.eventsPath(runID),
	}
	for _, f := range files {
		if err := zw.AddFile(f, filepath.Base(f)); err != nil {
			return err
		}
	}

	artDir := filepath.Join(dir, "artifacts")
	if _, err := os.Stat(artDir); err == nil {
		_ = filepath.WalkDir(artDir, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				return nil
			}
			rel, _ := filepath.Rel(dir, path)
			rel = filepath.ToSlash(rel)
			_ = zw.AddFile(path, rel)
			return nil
		})
	}

	return nil
}
