package main

import (
	"fmt"
	"time"

	"github.com/esengine/sikong/internal/store"
	"github.com/esengine/sikong/internal/workflow"
)

// ── task dispatch ──────────────────────────────────────────────────────────

func runTask(args []string) {
	flags, positionals := parseFlags(args)
	dir := resolveDir(flags["--dir"])

	projectID := flags["--project"]
	if projectID == "" {
		fail("--project is required")
	}

	if len(positionals) < 1 {
		fail("usage: sikong <description> --project <id> [--workflow <id>]")
	}
	description := positionals[0]
	workflowID := flags["--workflow"]
	if workflowID == "" {
		workflowID = "general"
	}

	registry := store.NewJSONWorkflowRegistry(dir)
	wf, err := registry.Get(workflowID, "")
	if err != nil {
		fail("error loading workflow: %v", err)
	}
	if wf == nil {
		fail("workflow %q not found", workflowID)
	}
	if len(wf.Stages) == 0 {
		fail("workflow %q has no stages", workflowID)
	}
	stageID := wf.Stages[0].ID

	// Generate short ref: time-based 6-char hex
	ref := fmt.Sprintf("%06x", time.Now().UnixNano()&0xffffff)
	taskID := ref

	ps := store.NewJSONProjectStore(dir)
	proj, err := ps.Get(projectID)
	if err != nil {
		fail("error: %v", err)
	}
	if proj == nil {
		fail("project %q not found", projectID)
	}

	es := store.NewJSONLEventStore(dir)

	createdEvent := workflow.NewEvent{
		Type:   workflow.TaskEventCreated,
		Source: "user",
		Payload: map[string]interface{}{
			"taskId":          taskID,
			"projectId":       projectID,
			"workflowId":      wf.ID,
			"workflowVersion": wf.Version,
			"stageId":         stageID,
			"request":         description,
			"fields":          map[string]interface{}{"request": description},
		},
	}

	stamped, err := es.Append(taskID, []workflow.NewEvent{createdEvent})
	if err != nil {
		fail("error creating task: %v", err)
	}

	task := &workflow.Task{
		ID:              taskID,
		ProjectID:       projectID,
		WorkflowID:      wf.ID,
		WorkflowVersion: wf.Version,
		StageID:         stageID,
		Status:          workflow.StatusForStage(*wf, stageID),
		Fields:          map[string]interface{}{"request": description},
		CreatedAt:       stamped[0].TS,
		UpdatedAt:       stamped[0].TS,
	}

	projPs := store.NewJSONProjectionStore(dir)
	if err := projPs.Put(*task); err != nil {
		fail("error: %v", err)
	}

	// Record in chronicle
	cs := store.NewJSONLChronicleStore(dir)
	cs.Append(store.ChronicleEntry{
		Type:    store.ChronicleTaskCreated,
		TaskID:  taskID,
		Summary: description,
		Data:    map[string]interface{}{"projectId": projectID, "workflowId": wf.ID},
	})

	fmt.Printf("@%s\n", ref)
}

// ── lead conversation: steer / approve / reject / cancel ───────────────────

func resolveRef(args []string) (string, string, string) {
	flags, positionals := parseFlags(args)
	dir := resolveDir(flags["--dir"])

	if len(positionals) < 1 {
		return "", "", ""
	}
	ref := positionals[0]
	taskID := ref

	// Verify task exists
	ps := store.NewJSONProjectionStore(dir)
	task, err := ps.Get(taskID)
	if err != nil {
		fail("error: %v", err)
	}
	if task == nil {
		fail("task @%s not found", ref)
	}
	return dir, ref, taskID
}

func runSteer(args []string) {
	flags, positionals := parseFlags(args)
	dir := resolveDir(flags["--dir"])

	if len(positionals) < 1 {
		fail("usage: sikong steer <ref> <message>")
	}
	ref := positionals[0]
	taskID := ref

	message := ""
	if len(positionals) > 1 {
		message = positionals[1]
	}
	if message == "" {
		fail("usage: sikong steer <ref> <message>")
	}

	// Verify task exists
	ps := store.NewJSONProjectionStore(dir)
	task, err := ps.Get(taskID)
	if err != nil {
		fail("error: %v", err)
	}
	if task == nil {
		fail("task @%s not found", ref)
	}

	// Record steer message in chronicle
	cs := store.NewJSONLChronicleStore(dir)
	cs.Append(store.ChronicleEntry{
		Type:    store.ChronicleLeadMessage,
		TaskID:  taskID,
		Summary: "steer: " + message,
		Data:    map[string]interface{}{"message": message, "kind": "steer"},
	})

	printJSON(map[string]interface{}{
		"ok":      true,
		"ref":     "@" + ref,
		"message": message,
	})
}

func runApprove(args []string) {
	dir, ref, taskID := resolveRef(args)
	if dir == "" {
		fail("usage: sikong approve <ref>")
	}

	cs := store.NewJSONLChronicleStore(dir)
	cs.Append(store.ChronicleEntry{
		Type:    store.ChronicleLeadMessage,
		TaskID:  taskID,
		Summary: "approved",
		Data:    map[string]interface{}{"action": "approve"},
	})

	printJSON(map[string]interface{}{
		"ok":  true,
		"ref": "@" + ref,
	})
}

func runReject(args []string) {
	flags, positionals := parseFlags(args)
	dir := resolveDir(flags["--dir"])

	if len(positionals) < 1 {
		fail("usage: sikong reject <ref> --reason <text>")
	}
	ref := positionals[0]
	taskID := ref
	reason := flags["--reason"]
	if reason == "" {
		fail("--reason is required")
	}

	ps := store.NewJSONProjectionStore(dir)
	task, err := ps.Get(taskID)
	if err != nil {
		fail("error: %v", err)
	}
	if task == nil {
		fail("task @%s not found", ref)
	}

	cs := store.NewJSONLChronicleStore(dir)
	cs.Append(store.ChronicleEntry{
		Type:    store.ChronicleLeadMessage,
		TaskID:  taskID,
		Summary: "rejected: " + reason,
		Data:    map[string]interface{}{"action": "reject", "reason": reason},
	})

	printJSON(map[string]interface{}{
		"ok":     true,
		"ref":    "@" + ref,
		"reason": reason,
	})
}

func runCancel(args []string) {
	flags, positionals := parseFlags(args)
	dir := resolveDir(flags["--dir"])

	if len(positionals) < 1 {
		fail("usage: sikong cancel <ref> --reason <text>")
	}
	ref := positionals[0]
	taskID := ref
	reason := flags["--reason"]
	if reason == "" {
		reason = "cancelled by user"
	}

	ps := store.NewJSONProjectionStore(dir)
	task, err := ps.Get(taskID)
	if err != nil {
		fail("error: %v", err)
	}
	if task == nil {
		fail("task @%s not found", ref)
	}

	cs := store.NewJSONLChronicleStore(dir)
	cs.Append(store.ChronicleEntry{
		Type:    store.ChronicleLeadMessage,
		TaskID:  taskID,
		Summary: "cancelled: " + reason,
		Data:    map[string]interface{}{"action": "cancel", "reason": reason},
	})

	printJSON(map[string]interface{}{
		"ok":     true,
		"ref":    "@" + ref,
		"reason": reason,
	})
}

// ── show ───────────────────────────────────────────────────────────────────

func runShow(args []string) {
	dir, ref, taskID := resolveRef(args)
	if dir == "" {
		fail("usage: sikong show <ref>")
	}

	ps := store.NewJSONProjectionStore(dir)
	task, err := ps.Get(taskID)
	if err != nil {
		fail("error: %v", err)
	}
	if task == nil {
		fail("task @%s not found", ref)
	}

	es := store.NewJSONLEventStore(dir)
	events, _ := es.Load(taskID, 0)

	cs := store.NewJSONLChronicleStore(dir)
	chronicle, _ := cs.Recent(store.ChronicleQuery{TaskID: taskID, Limit: 50})

	printJSON(map[string]interface{}{
		"task":      task,
		"events":    events,
		"chronicle": chronicle,
	})
}
