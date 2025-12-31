package runstore

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestStore_CreateRun_AppendEvent_Export(t *testing.T) {
	tmp := t.TempDir()
	s := New(tmp)
	if err := s.Init(); err != nil {
		t.Fatalf("init: %v", err)
	}

	ws := filepath.Join(tmp, "ws")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	spec := filepath.Join(tmp, "spec.md")
	if err := os.WriteFile(spec, []byte("# spec"), 0o644); err != nil {
		t.Fatal(err)
	}

	run, err := s.CreateRun(ws, spec)
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if run.ID == "" {
		t.Fatal("expected run id")
	}

	if err := s.AppendEvent(run.ID, Event{Type: "log", Message: "hello"}); err != nil {
		t.Fatalf("append event: %v", err)
	}

	events, err := s.ReadEvents(run.ID, 10)
	if err != nil {
		t.Fatalf("read events: %v", err)
	}
	if len(events) == 0 {
		t.Fatal("expected events")
	}

	var buf bytes.Buffer
	if err := s.ExportRun(run.ID, &buf); err != nil {
		t.Fatalf("export: %v", err)
	}
	if buf.Len() == 0 {
		t.Fatal("expected non-empty zip")
	}
}
