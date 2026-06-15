package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/esengine/sikong/internal/store"
	"github.com/esengine/sikong/internal/workflow"
)

// TestGoCLIStoreIntegration tests the Go CLI's store operations end-to-end
// without needing a daemon or worker subprocess.
func TestGoCLIStoreIntegration(t *testing.T) {
	dir := t.TempDir()

	// Create a task via direct store calls (same logic as CLI create)
	es := store.NewJSONLEventStore(dir)
	ps := store.NewJSONProjectionStore(dir)

	events, err := es.Append("test_001", []workflow.NewEvent{
		{Type: "task.created", Payload: map[string]interface{}{"projectId": "default", "workflowId": "general"}},
	})
	if err != nil {
		t.Fatalf("Append failed: %v", err)
	}
	if len(events) != 1 || events[0].Seq != 1 {
		t.Fatalf("expected 1 event seq=1, got %d seq=%d", len(events), events[0].Seq)
	}

	task := createTestTaskGo("test_001")
	if err := ps.Put(*task); err != nil {
		t.Fatalf("Put projection failed: %v", err)
	}

	// Read back via status command
	tasks, err := ps.Query(store.TaskQuery{})
	if err != nil {
		t.Fatalf("Query failed: %v", err)
	}
	if len(tasks) != 1 {
		t.Fatalf("expected 1 task, got %d", len(tasks))
	}
	if tasks[0].ID != "test_001" {
		t.Errorf("expected test_001, got %s", tasks[0].ID)
	}
}

// TestGoCLIWritesTSReadableFormat verifies the Go store writes files that the
// TS store can read (shared JSONL format).
func TestGoCLIWritesTSReadableFormat(t *testing.T) {
	dir := t.TempDir()

	es := store.NewJSONLEventStore(dir)
	events, err := es.Append("cross_task", []workflow.NewEvent{
		{Type: "task.created", Payload: map[string]interface{}{"workflowId": "general"}},
	})
	if err != nil {
		t.Fatalf("Append failed: %v", err)
	}

	// Verify the JSONL has the TS-expected field names
	data, err := os.ReadFile(filepath.Join(dir, "projects", "default", "state", "events", "cross_task.jsonl"))
	if err != nil {
		t.Fatalf("read event file: %v", err)
	}

	// The line should be valid JSON with taskId, type, seq, ts
	var parsed map[string]interface{}
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(data))), &parsed); err != nil {
		t.Fatalf("not valid JSON: %v", err)
	}

	required := []string{"seq", "taskId", "type", "ts"}
	for _, f := range required {
		if _, ok := parsed[f]; !ok {
			t.Errorf("missing field %s", f)
		}
	}
	if parsed["seq"].(float64) != 1 {
		t.Errorf("expected seq 1, got %v", parsed["seq"])
	}

	_ = events
}

func TestProjectDirFlagDoesNotConsumeSubcommandFlags(t *testing.T) {
	dir, rest := extractDirFlag([]string{"create", "p1", "--root", "/repo", "--dir", "/tmp/ws", "--lead", "codex"})
	if dir != "/tmp/ws" {
		t.Fatalf("expected dir /tmp/ws, got %s", dir)
	}
	want := []string{"create", "p1", "--root", "/repo", "--lead", "codex"}
	if len(rest) != len(want) {
		t.Fatalf("expected rest %v, got %v", want, rest)
	}
	for i := range want {
		if rest[i] != want[i] {
			t.Fatalf("expected rest %v, got %v", want, rest)
		}
	}
}

func createTestTaskGo(id string) *workflow.Task {
	return &workflow.Task{
		ID:              id,
		ProjectID:       "default",
		WorkflowID:      "general",
		WorkflowVersion: "1",
		StageID:         "open",
		Status:          workflow.TaskStatusTodo,
		Fields:          map[string]interface{}{},
		Depth:           0,
		CreatedAt:       1718000000000,
		UpdatedAt:       1718000000000,
	}
}
