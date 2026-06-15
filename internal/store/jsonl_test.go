package store

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/esengine/sikong/internal/workflow"
)

func TestJSONLEventStore_AppendAndLoad(t *testing.T) {
	dir := t.TempDir()
	s := NewJSONLEventStore(dir)

	// Appending to a new task
	events, err := s.Append("task_001", []workflow.NewEvent{
		{Type: "task.created", Payload: map[string]interface{}{"workflowId": "general"}},
		{Type: "field.set", Payload: map[string]interface{}{"field": "title", "value": "hello"}},
	})
	if err != nil {
		t.Fatalf("Append failed: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	if events[0].Seq != 1 {
		t.Errorf("expected seq 1, got %d", events[0].Seq)
	}
	if events[1].Seq != 2 {
		t.Errorf("expected seq 2, got %d", events[1].Seq)
	}
	if events[0].TaskID != "task_001" {
		t.Errorf("expected task_001, got %s", events[0].TaskID)
	}

	// Load all
	loaded, err := s.Load("task_001", 0)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if len(loaded) != 2 {
		t.Fatalf("expected 2 loaded, got %d", len(loaded))
	}

	// Load from seq
	loadedFrom2, err := s.Load("task_001", 1)
	if err != nil {
		t.Fatalf("Load from seq failed: %v", err)
	}
	if len(loadedFrom2) != 1 || loadedFrom2[0].Seq != 2 {
		t.Errorf("expected seq 2 only, got %v", loadedFrom2)
	}

	// Append more
	more, err := s.Append("task_001", []workflow.NewEvent{
		{Type: "transition.requested"},
	})
	if err != nil {
		t.Fatalf("Append more failed: %v", err)
	}
	if more[0].Seq != 3 {
		t.Errorf("expected seq 3, got %d", more[0].Seq)
	}

	// Verify total
	all, _ := s.Load("task_001", 0)
	if len(all) != 3 {
		t.Errorf("expected 3 total, got %d", len(all))
	}
}

func TestJSONLEventStore_FilePersistence(t *testing.T) {
	dir := t.TempDir()
	s := NewJSONLEventStore(dir)

	s.Append("task_002", []workflow.NewEvent{
		{Type: "task.created", Payload: map[string]interface{}{"workflowId": "dev"}},
	})

	// Verify the file was created
	expectedFile := filepath.Join(dir, "projects", "default", "state", "events", "task_002.jsonl")
	if _, err := os.Stat(expectedFile); os.IsNotExist(err) {
		t.Fatalf("expected event file at %s", expectedFile)
	}

	// Open a new store instance reading the same directory
	s2 := NewJSONLEventStore(dir)
	loaded, err := s2.Load("task_002", 0)
	if err != nil {
		t.Fatalf("Load from new instance failed: %v", err)
	}
	if len(loaded) != 1 {
		t.Fatalf("expected 1 event, got %d", len(loaded))
	}
	if loaded[0].Seq != 1 {
		t.Errorf("expected seq 1, got %d", loaded[0].Seq)
	}
}

func TestJSONLEventStore_UnknownTask(t *testing.T) {
	dir := t.TempDir()
	s := NewJSONLEventStore(dir)

	events, err := s.Load("nonexistent", 0)
	if err != nil {
		t.Fatalf("Load nonexistent failed: %v", err)
	}
	if len(events) != 0 {
		t.Errorf("expected 0 events, got %d", len(events))
	}
}

func TestJSONLEventStore_SeqConcurrentSafety(t *testing.T) {
	dir := t.TempDir()
	s := NewJSONLEventStore(dir)

	// Simulate two concurrent appends from separate processes using separate instances
	s1 := NewJSONLEventStore(dir)
	s2 := NewJSONLEventStore(dir)

	errCh := make(chan error, 4)
	// Each instance appends two events
	go func() {
		_, err := s1.Append("task_003", []workflow.NewEvent{{Type: "field.set", Payload: map[string]interface{}{"field": "a"}}})
		errCh <- err
	}()
	go func() {
		_, err := s2.Append("task_003", []workflow.NewEvent{{Type: "field.set", Payload: map[string]interface{}{"field": "b"}}})
		errCh <- err
	}()
	go func() {
		_, err := s1.Append("task_003", []workflow.NewEvent{{Type: "field.set", Payload: map[string]interface{}{"field": "c"}}})
		errCh <- err
	}()
	go func() {
		_, err := s2.Append("task_003", []workflow.NewEvent{{Type: "field.set", Payload: map[string]interface{}{"field": "d"}}})
		errCh <- err
	}()

	// Collect all results
	for i := 0; i < 4; i++ {
		if err := <-errCh; err != nil {
			t.Errorf("Append failed: %v", err)
		}
	}

	all, _ := s.Load("task_003", 0)
	if len(all) != 4 {
		t.Errorf("expected 4 events, got %d (seq collision possible without lock)", len(all))
	}
	// Verify seqs are monotonically increasing and unique
	seqs := make(map[int]bool)
	for _, ev := range all {
		if seqs[ev.Seq] {
			t.Errorf("duplicate seq %d", ev.Seq)
		}
		seqs[ev.Seq] = true
	}
	// Verify we have seqs 1-4
	for i := 1; i <= 4; i++ {
		if !seqs[i] {
			t.Errorf("missing seq %d", i)
		}
	}
}

func TestJSONLEventStore_TornTail(t *testing.T) {
	dir := t.TempDir()
	s := NewJSONLEventStore(dir)

	// Write a valid event then a torn (partial) line
	eventFile := filepath.Join(dir, "events", "task_torn.jsonl")
	os.MkdirAll(filepath.Dir(eventFile), 0755)
	os.WriteFile(eventFile, []byte(`{"seq":1,"taskId":"task_torn","type":"task.created","ts":1000}
{"seq":2,"taskId":"task_torn","type":"field.set","ts":1001}
{"seq":3,"taskId":"task_torn","type":"partial`+"\n"), 0644)

	loaded, err := s.Load("task_torn", 0)
	if err != nil {
		t.Fatalf("Load with torn tail failed: %v", err)
	}
	if len(loaded) != 2 {
		t.Errorf("expected 2 events (torn tail dropped), got %d", len(loaded))
	}
}

func TestJSONLEventStore_LargeSeqs(t *testing.T) {
	dir := t.TempDir()
	s := NewJSONLEventStore(dir)

	// Append 50 events
	var batch []workflow.NewEvent
	for i := 0; i < 50; i++ {
		batch = append(batch, workflow.NewEvent{
			Type:    "progress",
			Payload: map[string]interface{}{"step": i},
		})
	}
	events, err := s.Append("task_large", batch)
	if err != nil {
		t.Fatalf("Append batch failed: %v", err)
	}
	if len(events) != 50 {
		t.Fatalf("expected 50 events, got %d", len(events))
	}
	if events[0].Seq != 1 || events[49].Seq != 50 {
		t.Errorf("expected seq 1-50, got %d-%d", events[0].Seq, events[49].Seq)
	}

	// Append another 50
	s.Append("task_large", batch)
	all, _ := s.Load("task_large", 0)
	if len(all) != 100 {
		t.Errorf("expected 100 events, got %d", len(all))
	}
}
