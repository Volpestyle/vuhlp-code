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
	"time"

	"github.com/yourorg/coding-agent-harness/internal/util"
)

func (s *Store) sessionsDir() string {
	return filepath.Join(s.dataDir, "sessions")
}

func (s *Store) sessionDir(sessionID string) string {
	return filepath.Join(s.sessionsDir(), sessionID)
}

func (s *Store) sessionPath(sessionID string) string {
	return filepath.Join(s.sessionDir(sessionID), "session.json")
}

func (s *Store) sessionEventsPath(sessionID string) string {
	return filepath.Join(s.sessionDir(sessionID), "events.ndjson")
}

func (s *Store) sessionAttachmentsDir(sessionID string) string {
	return filepath.Join(s.sessionDir(sessionID), "attachments")
}

func (s *Store) sessionArtifactsDir(sessionID string, turnID string) string {
	return filepath.Join(s.sessionDir(sessionID), "artifacts", turnID)
}

func (s *Store) CreateSession(workspacePath, systemPrompt, mode, specPath string) (*Session, error) {
	if strings.TrimSpace(workspacePath) == "" {
		return nil, errors.New("workspacePath is empty")
	}
	if strings.TrimSpace(mode) == "" {
		mode = string(SessionModeChat)
	}
	session := &Session{
		ID:            util.NewSessionID(),
		CreatedAt:     time.Now().UTC(),
		UpdatedAt:     time.Now().UTC(),
		Status:        SessionActive,
		Mode:          SessionMode(mode),
		WorkspacePath: workspacePath,
		SystemPrompt:  strings.TrimSpace(systemPrompt),
		SpecPath:      strings.TrimSpace(specPath),
	}
	dir := s.sessionDir(session.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(s.sessionEventsPath(session.ID), []byte{}, 0o644); err != nil {
		return nil, err
	}
	if err := s.saveSession(session); err != nil {
		return nil, err
	}
	s.sessionsMu.Lock()
	s.sessions[session.ID] = session
	s.sessionsMu.Unlock()

	_ = s.AppendSessionEvent(session.ID, SessionEvent{
		TS:        time.Now().UTC(),
		SessionID: session.ID,
		Type:      "session_created",
		Data: map[string]any{
			"workspace_path": workspacePath,
		},
	})

	return session, nil
}

func (s *Store) saveSession(session *Session) error {
	session.UpdatedAt = time.Now().UTC()
	b, err := json.MarshalIndent(session, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.sessionPath(session.ID), append(b, '\n'), 0o644)
}

func (s *Store) UpdateSession(session *Session) error {
	if session == nil {
		return errors.New("session is nil")
	}
	s.sessionsMu.Lock()
	s.sessions[session.ID] = session
	s.sessionsMu.Unlock()
	return s.saveSession(session)
}

func (s *Store) GetSession(sessionID string) (*Session, error) {
	s.sessionsMu.RLock()
	defer s.sessionsMu.RUnlock()
	session, ok := s.sessions[sessionID]
	if !ok {
		return nil, fmt.Errorf("session not found: %s", sessionID)
	}
	cp := *session
	return &cp, nil
}

func (s *Store) ListSessions() ([]Session, error) {
	s.sessionsMu.RLock()
	defer s.sessionsMu.RUnlock()
	out := make([]Session, 0, len(s.sessions))
	for _, session := range s.sessions {
		out = append(out, *session)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out, nil
}

func (s *Store) AppendMessage(sessionID string, msg Message) (*Session, error) {
	session, err := s.GetSession(sessionID)
	if err != nil {
		return nil, err
	}
	session.Messages = append(session.Messages, msg)
	if err := s.UpdateSession(session); err != nil {
		return nil, err
	}
	return session, nil
}

func (s *Store) AddTurn(sessionID string) (string, error) {
	session, err := s.GetSession(sessionID)
	if err != nil {
		return "", err
	}
	turn := Turn{
		ID:     util.NewTurnID(),
		Status: TurnPending,
	}
	session.Turns = append(session.Turns, turn)
	session.LastTurnID = turn.ID
	if err := s.UpdateSession(session); err != nil {
		return "", err
	}
	return turn.ID, nil
}

func (s *Store) AppendSessionEvent(sessionID string, ev SessionEvent) error {
	ev.TS = ev.TS.UTC()
	if ev.SessionID == "" {
		ev.SessionID = sessionID
	}

	f, err := os.OpenFile(s.sessionEventsPath(sessionID), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
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

	s.sessionSubsMu.Lock()
	defer s.sessionSubsMu.Unlock()
	for ch := range s.sessionSubs[sessionID] {
		select {
		case ch <- ev:
		default:
		}
	}
	return nil
}

func (s *Store) SubscribeSession(sessionID string) (<-chan SessionEvent, func()) {
	ch := make(chan SessionEvent, 256)
	s.sessionSubsMu.Lock()
	if s.sessionSubs[sessionID] == nil {
		s.sessionSubs[sessionID] = map[chan SessionEvent]struct{}{}
	}
	s.sessionSubs[sessionID][ch] = struct{}{}
	s.sessionSubsMu.Unlock()

	cancel := func() {
		s.sessionSubsMu.Lock()
		if m := s.sessionSubs[sessionID]; m != nil {
			delete(m, ch)
		}
		s.sessionSubsMu.Unlock()
		close(ch)
	}
	return ch, cancel
}

// ReadSessionEvents reads up to max events from the NDJSON log (0 => all).
func (s *Store) ReadSessionEvents(sessionID string, max int) ([]SessionEvent, error) {
	f, err := os.Open(s.sessionEventsPath(sessionID))
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var out []SessionEvent
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var ev SessionEvent
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

func (s *Store) SaveSessionAttachment(sessionID, filename, mimeType string, content []byte) (string, string, error) {
	if sessionID == "" {
		return "", "", errors.New("sessionID required")
	}
	dir := s.sessionAttachmentsDir(sessionID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", err
	}
	name := strings.TrimSpace(filename)
	if name == "" {
		name = util.NewAttachmentID()
	}
	name = filepath.Base(name)
	if name == "." || name == string(os.PathSeparator) {
		name = util.NewAttachmentID()
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	ext := filepath.Ext(name)
	if ext == "" {
		name = name + ".bin"
	}

	path := filepath.Join(dir, name)
	if _, err := os.Stat(path); err == nil {
		name = util.NewAttachmentID() + ext
		path = filepath.Join(dir, name)
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return "", "", err
	}
	ref := filepath.ToSlash(filepath.Join("attachments", name))
	return ref, mimeType, nil
}

func (s *Store) RequireSessionApproval(sessionID, toolCallID string) (<-chan ApprovalDecision, error) {
	if sessionID == "" || toolCallID == "" {
		return nil, errors.New("sessionID and toolCallID required")
	}
	s.sessionApprovalMu.Lock()
	defer s.sessionApprovalMu.Unlock()
	if s.sessionApprovals[sessionID] == nil {
		s.sessionApprovals[sessionID] = map[string]chan ApprovalDecision{}
	}
	if _, ok := s.sessionApprovals[sessionID][toolCallID]; ok {
		return nil, fmt.Errorf("approval already pending for tool call %s", toolCallID)
	}
	ch := make(chan ApprovalDecision, 1)
	s.sessionApprovals[sessionID][toolCallID] = ch
	return ch, nil
}

func (s *Store) ApproveSessionToolCall(sessionID, toolCallID string, decision ApprovalDecision) error {
	s.sessionApprovalMu.Lock()
	defer s.sessionApprovalMu.Unlock()
	m := s.sessionApprovals[sessionID]
	if m == nil {
		return fmt.Errorf("no approvals pending for session %s", sessionID)
	}
	ch, ok := m[toolCallID]
	if !ok {
		return fmt.Errorf("no approval pending for tool call %s", toolCallID)
	}
	ch <- decision
	close(ch)
	delete(m, toolCallID)
	return nil
}

func (s *Store) WaitForSessionApproval(ctx context.Context, sessionID, toolCallID string) (ApprovalDecision, error) {
	s.sessionApprovalMu.Lock()
	ch := s.sessionApprovals[sessionID][toolCallID]
	s.sessionApprovalMu.Unlock()

	if ch == nil {
		return ApprovalDecision{}, fmt.Errorf("no approval pending for tool call %s", toolCallID)
	}
	select {
	case <-ctx.Done():
		return ApprovalDecision{}, ctx.Err()
	case decision := <-ch:
		return decision, nil
	}
}

// Cancellation helpers

func (s *Store) SetSessionCancel(sessionID string, cancel context.CancelFunc) {
	s.sessionCancelMu.Lock()
	defer s.sessionCancelMu.Unlock()
	s.sessionCancels[sessionID] = cancel
}

func (s *Store) CancelSession(sessionID string) {
	s.sessionCancelMu.Lock()
	cancel := s.sessionCancels[sessionID]
	s.sessionCancelMu.Unlock()
	if cancel != nil {
		cancel()
	}
	session, err := s.GetSession(sessionID)
	if err != nil {
		return
	}
	if session.Status == SessionActive || session.Status == SessionWaitingApproval {
		session.Status = SessionCanceled
		if session.Error == "" {
			session.Error = "canceled"
		}
		_ = s.UpdateSession(session)
	}
}

// ExportSession zips session.json + events.ndjson + attachments/ + artifacts/ (if present).
func (s *Store) ExportSession(sessionID string, w io.Writer) error {
	dir := s.sessionDir(sessionID)
	if _, err := os.Stat(dir); err != nil {
		return err
	}
	zw := NewZipWriter(w)
	defer zw.Close()

	files := []string{
		s.sessionPath(sessionID),
		s.sessionEventsPath(sessionID),
	}
	for _, f := range files {
		if err := zw.AddFile(f, filepath.Base(f)); err != nil {
			return err
		}
	}

	addDir := func(subdir string) {
		if _, err := os.Stat(subdir); err == nil {
			_ = filepath.WalkDir(subdir, func(path string, d os.DirEntry, err error) error {
				if err != nil || d.IsDir() {
					return nil
				}
				rel, _ := filepath.Rel(dir, path)
				rel = filepath.ToSlash(rel)
				_ = zw.AddFile(path, rel)
				return nil
			})
		}
	}

	addDir(filepath.Join(dir, "attachments"))
	addDir(filepath.Join(dir, "artifacts"))

	return nil
}
