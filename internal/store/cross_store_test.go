package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/esengine/sikong/internal/workflow"
)

// TestGoStoreFormatCompatibility verifies that files written by the Go store
// are readable by the TS store implementation (and vice versa) by checking
// the exact file format conventions.
func TestGoStoreFormatCompatibility(t *testing.T) {
	dir := t.TempDir()

	// Write events using Go store
	es := NewJSONLEventStore(dir)
	es.Append("cross_001", []workflow.NewEvent{
		{Type: "task.created", Payload: map[string]interface{}{"workflowId": "cross"}},
		{Type: "field.set", Payload: map[string]interface{}{"field": "x", "value": "1"}},
	})

	// Verify the JSONL file is well-formed per TS conventions
	eventFile := filepath.Join(dir, "projects", "default", "state", "events", "cross_001.jsonl")
	data, err := os.ReadFile(eventFile)
	if err != nil {
		t.Fatalf("read event file: %v", err)
	}

	lines := splitLines(string(data))
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d", len(lines))
	}

	// Each line must be valid JSON with the TS-expected fields
	for i, line := range lines {
		var obj map[string]interface{}
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			t.Fatalf("line %d is not valid JSON: %v", i, err)
		}
		// TS expects: seq, taskId, type, ts (required fields)
		if _, ok := obj["seq"]; !ok {
			t.Errorf("line %d missing 'seq'", i)
		}
		if _, ok := obj["taskId"]; !ok {
			t.Errorf("line %d missing 'taskId'", i)
		}
		if _, ok := obj["type"]; !ok {
			t.Errorf("line %d missing 'type'", i)
		}
		if _, ok := obj["ts"]; !ok {
			t.Errorf("line %d missing 'ts'", i)
		}
	}

	// Write a projection using Go store
	ps := NewJSONProjectionStore(dir)
	task := createTestTask("cross_001")
	ps.Put(*task)

	// Verify projection file matches TS conventions
	projFile := filepath.Join(dir, "projects", "default", "state", "projections", "cross_001.json")
	projData, err := os.ReadFile(projFile)
	if err != nil {
		t.Fatalf("read projection file: %v", err)
	}
	var projObj map[string]interface{}
	if err := json.Unmarshal(projData, &projObj); err != nil {
		t.Fatalf("projection is not valid JSON: %v", err)
	}
	// TS expects: id, projectId, workflowId, stageId, status, fields
	requiredFields := []string{"id", "projectId", "workflowId", "stageId", "status", "fields"}
	for _, f := range requiredFields {
		if _, ok := projObj[f]; !ok {
			t.Errorf("projection missing field '%s'", f)
		}
	}

	// Write chronicle using Go store
	cs := NewJSONLChronicleStore(dir)
	cs.Append(ChronicleEntry{
		Type:    ChronicleWakeEnd,
		TaskID:  "cross_001",
		Summary: "wake completed",
	})

	// Verify chronicle file
	chronicleFile := filepath.Join(dir, "state", "chronicle.jsonl")
	chrData, err := os.ReadFile(chronicleFile)
	if err != nil {
		t.Fatalf("read chronicle file: %v", err)
	}
	chrLines := splitLines(string(chrData))
	if len(chrLines) != 1 {
		t.Fatalf("expected 1 chronicle line, got %d", len(chrLines))
	}
	var chrObj map[string]interface{}
	json.Unmarshal([]byte(chrLines[0]), &chrObj)
	if _, ok := chrObj["seq"]; !ok {
		t.Errorf("chronicle missing 'seq'")
	}
	if _, ok := chrObj["ts"]; !ok {
		t.Errorf("chronicle missing 'ts'")
	}
}

func createTestTask(id string) *workflow.Task {
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

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			if i > start {
				lines = append(lines, s[start:i])
			}
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}
