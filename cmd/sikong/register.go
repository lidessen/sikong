package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/esengine/sikong/internal/store"
)

// ── register ────────────────────────────────────────────────────────────────

func runRegister(dir string, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: sikong register <workflow.yaml>")
		os.Exit(1)
	}
	path := args[0]

	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error reading %s: %v\n", path, err)
		os.Exit(1)
	}

	// Extract id and version from the file
	var raw struct {
		ID      string `yaml:"id"`
		Version string `yaml:"version"`
	}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		fmt.Fprintf(os.Stderr, "error parsing workflow: %v\n", err)
		os.Exit(1)
	}
	if raw.ID == "" {
		fmt.Fprintln(os.Stderr, "workflow must have an 'id' field")
		os.Exit(1)
	}
	if raw.Version == "" {
		raw.Version = "1"
	}

	if err := store.SaveWorkflow(dir, raw.ID, raw.Version, data); err != nil {
		fmt.Fprintf(os.Stderr, "error saving workflow: %v\n", err)
		os.Exit(1)
	}

	json.NewEncoder(os.Stdout).Encode(map[string]interface{}{
		"ok":         true,
		"workflowId": raw.ID,
		"version":    raw.Version,
	})
}

// ── trace ───────────────────────────────────────────────────────────────────

type traceEntry struct {
	Seq     int                    `json:"seq"`
	Type    string                 `json:"type"`
	TaskID  string                 `json:"taskId,omitempty"`
	Summary string                 `json:"summary"`
	Data    map[string]interface{} `json:"data,omitempty"`
	TS      int64                  `json:"ts"`
}

func runTrace(dir string, args []string) {
	flags, positionals := parseFlags(args)

	taskID := flags["--task"]
	if taskID == "" && len(positionals) > 0 {
		taskID = positionals[0]
	}
	if taskID == "" {
		fmt.Fprintln(os.Stderr, "usage: sikong trace <taskId> [--text]")
		os.Exit(1)
	}

	// Get task projection
	ps := store.NewJSONProjectionStore(dir)
	task, err := ps.Get(taskID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	if task == nil {
		fmt.Fprintf(os.Stderr, "task %s not found\n", taskID)
		os.Exit(1)
	}

	// Get chronicle entries
	cs := store.NewJSONLChronicleStore(dir)
	entries, err := cs.Recent(store.ChronicleQuery{
		TaskID: taskID,
		Limit:  300,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	// Get events
	es := store.NewJSONLEventStore(dir)
	events, err := es.Load(taskID, 0)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error loading events: %v\n", err)
		os.Exit(1)
	}

	result := map[string]interface{}{
		"task":     task,
		"events":   events,
		"chronicle": entries,
	}

	text := flags["--text"] != ""
	if text {
		fmt.Printf("Task: %s\n", task.ID)
		fmt.Printf("Status: %s  Stage: %s  Workflow: %s\n", task.Status, task.StageID, task.WorkflowID)
		fmt.Printf("Project: %s  Depth: %d\n", task.ProjectID, task.Depth)
		if len(entries) > 0 {
			fmt.Println("\nChronicle:")
			for _, e := range entries {
				fmt.Printf("  %s  %s  %s\n", e.Type, e.Summary, isoTime(e.TS))
			}
		}
		if len(events) > 0 {
			fmt.Println("\nEvents:")
			for _, e := range events {
				fmt.Printf("  #%d  %s  %s\n", e.Seq, e.Type, isoTime(e.TS))
			}
		}
		return
	}
	json.NewEncoder(os.Stdout).Encode(result)
}

func isoTime(ms int64) string {
	if ms == 0 {
		return "-"
	}
	return time.UnixMilli(ms).Format("15:04:05")
}
