package protocol

import (
	"encoding/json"
	"os"
	"testing"
)

// TestCrossLanguageTypeCompatibility reads JSON fixtures written by the TS
// cross-types.test.ts and validates that Go can deserialize them identically.
//
// Run: go test ./internal/protocol/ -run TestCrossLanguage
// The TS test must be run first to generate fixtures.
func TestCrossLanguageTypeCompatibility(t *testing.T) {
	dir := fixtureDir(t)
	if dir == "" {
		t.Skip("no FIXTURE_DIR set; run TS cross-types.test.ts first")
	}

	t.Run("Task", func(t *testing.T) {
		var task struct {
			ID             string `json:"id"`
			ProjectID      string `json:"projectId"`
			WorkflowID     string `json:"workflowId"`
			WorkflowVer    string `json:"workflowVersion"`
			Status         string `json:"status"`
			Depth          int    `json:"depth"`
			Fields         map[string]interface{} `json:"fields"`
			Scopes         map[string][]string     `json:"scopes"`
		}

		data := readFixture(t, dir, "task.json")
		if err := json.Unmarshal(data, &task); err != nil {
			t.Fatalf("failed to parse task: %v", err)
		}

		if task.ID != "task_test_001" {
			t.Errorf("expected task_test_001, got %s", task.ID)
		}
		if task.Status != "in_progress" {
			t.Errorf("expected in_progress, got %s", task.Status)
		}
		if task.Fields["title"] != "Implement login" {
			t.Errorf("expected 'Implement login', got %v", task.Fields["title"])
		}
		if task.Scopes["read"][0] != "project:default" {
			t.Errorf("expected project:default scope, got %v", task.Scopes["read"])
		}
		if task.Depth != 0 {
			t.Errorf("expected depth 0, got %d", task.Depth)
		}
	})

	t.Run("TaskEvent", func(t *testing.T) {
		var event struct {
			Seq     int    `json:"seq"`
			TaskID  string `json:"taskId"`
			Type    string `json:"type"`
			Payload map[string]interface{} `json:"payload"`
			Source  string `json:"source"`
		}

		data := readFixture(t, dir, "event.json")
		if err := json.Unmarshal(data, &event); err != nil {
			t.Fatalf("failed to parse event: %v", err)
		}

		if event.Seq != 1 {
			t.Errorf("expected seq 1, got %d", event.Seq)
		}
		if event.Type != "field.set" {
			t.Errorf("expected field.set, got %s", event.Type)
		}
		if event.Payload["field"] != "title" {
			t.Errorf("expected 'title', got %v", event.Payload["field"])
		}
	})

	t.Run("ChronicleEntry", func(t *testing.T) {
		var entry struct {
			Seq     int                    `json:"seq"`
			Type    string                 `json:"type"`
			Summary string                 `json:"summary"`
			Data    map[string]interface{} `json:"data"`
		}

		data := readFixture(t, dir, "chronicle.json")
		if err := json.Unmarshal(data, &entry); err != nil {
			t.Fatalf("failed to parse chronicle entry: %v", err)
		}

		if entry.Seq != 42 {
			t.Errorf("expected seq 42, got %d", entry.Seq)
		}
		if entry.Type != "wake.end" {
			t.Errorf("expected wake.end, got %s", entry.Type)
		}
		if entry.Summary != "wake completed: stage plan → done" {
			t.Errorf("expected summary to contain 'wake completed', got %s", entry.Summary)
		}
		if entry.Data["durationMs"].(float64) != 15000 {
			t.Errorf("expected durationMs 15000, got %v", entry.Data["durationMs"])
		}
	})

	t.Run("Worker", func(t *testing.T) {
		var worker struct {
			ID             string   `json:"id"`
			Runtime        string   `json:"runtime"`
			Roles          []string `json:"roles"`
		}

		data := readFixture(t, dir, "worker.json")
		if err := json.Unmarshal(data, &worker); err != nil {
			t.Fatalf("failed to parse worker: %v", err)
		}

		if worker.ID != "claude-code-anthropic" {
			t.Errorf("expected claude-code-anthropic, got %s", worker.ID)
		}
		if worker.Runtime != "claude-code" {
			t.Errorf("expected claude-code, got %s", worker.Runtime)
		}
		if len(worker.Roles) != 2 || worker.Roles[0] != "coding" {
			t.Errorf("expected roles [coding general], got %v", worker.Roles)
		}
	})

	t.Run("RpcRunWake", func(t *testing.T) {
		var msg struct {
			JSONRPC string `json:"jsonrpc"`
			ID      int    `json:"id"`
			Method  string `json:"method"`
			Params  struct {
				Worker struct {
					Runtime  string `json:"runtime"`
					Provider struct {
						ID    string `json:"id"`
						Model string `json:"model"`
					} `json:"provider"`
				} `json:"worker"`
				Task struct {
					TaskID string `json:"taskId"`
					Tools  map[string]struct {
						Description string      `json:"description"`
						InputSchema interface{} `json:"inputSchema"`
					} `json:"tools"`
				} `json:"task"`
			} `json:"params"`
		}

		data := readFixture(t, dir, "rpc-runWake.json")
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatalf("failed to parse RPC message: %v", err)
		}

		if msg.Method != "runWake" {
			t.Errorf("expected runWake, got %s", msg.Method)
		}
		if msg.Params.Worker.Provider.ID != "deepseek" {
			t.Errorf("expected deepseek, got %s", msg.Params.Worker.Provider.ID)
		}
		if msg.Params.Task.TaskID != "task_test_001" {
			t.Errorf("expected task_test_001, got %s", msg.Params.Task.TaskID)
		}
		if _, ok := msg.Params.Task.Tools["set_field"]; !ok {
			t.Error("expected set_field tool in task context")
		}
	})
}

func fixtureDir(t *testing.T) string {
	t.Helper()

	// Read the env var set by the TS test runner
	dir := os.Getenv("SIKONG_CROSS_FIXTURE_DIR")
	if dir != "" {
		return dir
	}

	return ""
}

func readFixture(t *testing.T, dir, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(dir + "/" + name)
	if err != nil {
		t.Fatalf("failed to read fixture %s: %v", name, err)
	}
	return data
}
