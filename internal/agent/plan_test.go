package agent

import "testing"

func TestParsePlanFromText(t *testing.T) {
	text := `{"steps":[{"id":"step_1","title":"t","type":"command","needs_approval":false,"command":"echo hi"}]}`
	p, err := parsePlanFromText(text)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Steps) != 1 {
		t.Fatalf("expected 1 step, got %d", len(p.Steps))
	}
}
