package main

import (
	"strings"
	"testing"

	"github.com/esengine/sikong/internal/protocol"
	"github.com/esengine/sikong/internal/store"
	"github.com/esengine/sikong/internal/workflow"
)

type fakeWakeRunner struct {
	result  *protocol.RunWakeResult
	taskCtx protocol.WakeTaskContext
}

func (f *fakeWakeRunner) RunWake(_ protocol.WakeWorkerConfig, taskCtx protocol.WakeTaskContext) (*protocol.RunWakeResult, error) {
	f.taskCtx = taskCtx
	return f.result, nil
}

func (f *fakeWakeRunner) Close() error {
	return nil
}

func TestExecuteWakeAppliesWorkerCommands(t *testing.T) {
	dir := t.TempDir()
	ds, err := NewDaemonScheduler(dir)
	if err != nil {
		t.Fatalf("NewDaemonScheduler failed: %v", err)
	}

	task := workflow.Task{
		ID:              "wake_task",
		ProjectID:       "p1",
		WorkflowID:      "general",
		WorkflowVersion: "1",
		StageID:         "open",
		Status:          workflow.TaskStatusTodo,
		Fields:          map[string]interface{}{"request": "do it"},
		CreatedAt:       1718000000000,
		UpdatedAt:       1718000000000,
	}
	seedTask(t, ds, task)

	fake := &fakeWakeRunner{
		result: &protocol.RunWakeResult{
			Usage:  protocol.TokenUsage{InputTokens: 1, OutputTokens: 2, TotalTokens: 3},
			Status: "completed",
			Text:   "done",
			Commands: []protocol.WakeCommand{
				{Kind: "set_field", Field: "summary", Value: "finished"},
				{Kind: "request_transition", Reason: "ready"},
			},
		},
	}
	ds.worker = fake

	if err := ds.ExecuteWake(task.ID); err != nil {
		t.Fatalf("ExecuteWake failed: %v", err)
	}

	if _, ok := fake.taskCtx.Tools["set_field"]; !ok {
		t.Fatalf("worker task context missing set_field tool")
	}
	if _, ok := fake.taskCtx.Tools["request_transition"]; !ok {
		t.Fatalf("worker task context missing request_transition tool")
	}

	updated, err := ds.projections.Get(task.ID)
	if err != nil {
		t.Fatalf("get projection failed: %v", err)
	}
	if updated == nil {
		t.Fatalf("projection missing")
	}
	if updated.Fields["summary"] != "finished" {
		t.Fatalf("expected summary field to be updated, got %#v", updated.Fields["summary"])
	}
	if updated.StageID != "done" {
		t.Fatalf("expected stage done, got %s", updated.StageID)
	}
	if updated.Status != workflow.TaskStatusDone {
		t.Fatalf("expected status done, got %s", updated.Status)
	}

	events, err := ds.events.Load(task.ID, 0)
	if err != nil {
		t.Fatalf("load events failed: %v", err)
	}
	assertEvent := func(eventType workflow.TaskEventType) workflow.TaskEvent {
		t.Helper()
		for _, event := range events {
			if event.Type == eventType {
				return event
			}
		}
		t.Fatalf("missing event %s in %#v", eventType, events)
		return workflow.TaskEvent{}
	}
	fieldSet := assertEvent(workflow.TaskEventFieldSet)
	transition := assertEvent(workflow.TaskEventTransitionRequested)
	stageEntered := assertEvent(workflow.TaskEventStageEntered)
	if fieldSet.WakeID == "" || transition.WakeID == "" || stageEntered.WakeID == "" {
		t.Fatalf("expected wakeId on command-derived events")
	}
	if fieldSet.WakeID != transition.WakeID || fieldSet.WakeID != stageEntered.WakeID {
		t.Fatalf("expected command-derived events to share wakeId")
	}

	entries, err := ds.chronicle.Recent(store.ChronicleQuery{TaskID: task.ID, Limit: 10})
	if err != nil {
		t.Fatalf("chronicle recent failed: %v", err)
	}
	if len(entries) == 0 {
		t.Fatalf("expected chronicle entries")
	}
}

func TestExecuteWakeAdvancesRegisteredWorkflowByGuard(t *testing.T) {
	dir := t.TempDir()
	ds, err := NewDaemonScheduler(dir)
	if err != nil {
		t.Fatalf("NewDaemonScheduler failed: %v", err)
	}
	wf := customWorkflow()
	if err := store.NewJSONWorkflowRegistry(dir).Register(wf); err != nil {
		t.Fatalf("register workflow failed: %v", err)
	}
	task := workflow.Task{
		ID:              "custom_task",
		ProjectID:       "p1",
		WorkflowID:      "custom",
		WorkflowVersion: "1",
		StageID:         "open",
		Status:          workflow.TaskStatusInProgress,
		Fields:          map[string]interface{}{},
	}
	seedTask(t, ds, task)

	ds.worker = &fakeWakeRunner{
		result: &protocol.RunWakeResult{
			Usage:  protocol.TokenUsage{InputTokens: 1, OutputTokens: 1, TotalTokens: 2},
			Status: "completed",
			Commands: []protocol.WakeCommand{
				{Kind: "set_field", Field: "approved", Value: true},
				{Kind: "request_transition", Reason: "approved"},
			},
		},
	}

	if err := ds.ExecuteWake(task.ID); err != nil {
		t.Fatalf("ExecuteWake failed: %v", err)
	}
	updated, err := ds.projections.Get(task.ID)
	if err != nil {
		t.Fatalf("get projection failed: %v", err)
	}
	if updated.StageID != "done" {
		t.Fatalf("expected custom workflow to advance to done, got %s", updated.StageID)
	}
	if updated.Status != workflow.TaskStatusDone {
		t.Fatalf("expected custom workflow status done, got %s", updated.Status)
	}
}

func TestExecuteWakeDoesNotAdvanceWhenGuardFails(t *testing.T) {
	dir := t.TempDir()
	ds, err := NewDaemonScheduler(dir)
	if err != nil {
		t.Fatalf("NewDaemonScheduler failed: %v", err)
	}
	wf := customWorkflow()
	if err := store.NewJSONWorkflowRegistry(dir).Register(wf); err != nil {
		t.Fatalf("register workflow failed: %v", err)
	}
	task := workflow.Task{
		ID:              "guard_fail",
		ProjectID:       "p1",
		WorkflowID:      "custom",
		WorkflowVersion: "1",
		StageID:         "open",
		Status:          workflow.TaskStatusInProgress,
		Fields:          map[string]interface{}{},
	}
	seedTask(t, ds, task)
	ds.worker = &fakeWakeRunner{
		result: &protocol.RunWakeResult{
			Usage:    protocol.TokenUsage{InputTokens: 1, OutputTokens: 1, TotalTokens: 2},
			Status:   "completed",
			Commands: []protocol.WakeCommand{{Kind: "request_transition", Reason: "not enough"}},
		},
	}

	if err := ds.ExecuteWake(task.ID); err != nil {
		t.Fatalf("ExecuteWake failed: %v", err)
	}
	updated, err := ds.projections.Get(task.ID)
	if err != nil {
		t.Fatalf("get projection failed: %v", err)
	}
	if updated.StageID != "open" {
		t.Fatalf("expected guard failure to stay open, got %s", updated.StageID)
	}
	if updated.Status != workflow.TaskStatusInProgress {
		t.Fatalf("expected status in_progress, got %s", updated.Status)
	}
	events, err := ds.events.Load(task.ID, 0)
	if err != nil {
		t.Fatalf("load events failed: %v", err)
	}
	for _, event := range events {
		if event.Type == workflow.TaskEventStageEntered {
			t.Fatalf("did not expect stage.entered when guard fails")
		}
	}
}

func TestExecuteWakeBuildsContextFromWorkflowStage(t *testing.T) {
	dir := t.TempDir()
	ds, err := NewDaemonScheduler(dir)
	if err != nil {
		t.Fatalf("NewDaemonScheduler failed: %v", err)
	}
	wf := contextWorkflow()
	if err := store.NewJSONWorkflowRegistry(dir).Register(wf); err != nil {
		t.Fatalf("register workflow failed: %v", err)
	}
	task := workflow.Task{
		ID:              "ctx_task",
		ProjectID:       "p1",
		WorkflowID:      "ctx",
		WorkflowVersion: "1",
		StageID:         "draft",
		Status:          workflow.TaskStatusInProgress,
		Fields:          map[string]interface{}{"request": "ship", "summary": ""},
	}
	seedTask(t, ds, task)
	fake := &fakeWakeRunner{
		result: &protocol.RunWakeResult{
			Usage:  protocol.TokenUsage{InputTokens: 1, OutputTokens: 1, TotalTokens: 2},
			Status: "completed",
		},
	}
	ds.worker = fake

	if err := ds.ExecuteWake(task.ID); err != nil {
		t.Fatalf("ExecuteWake failed: %v", err)
	}
	if fake.taskCtx.Effort != "high" {
		t.Fatalf("expected stage effort high, got %q", fake.taskCtx.Effort)
	}
	if !strings.Contains(fake.taskCtx.SystemPrompt, "Draft the final summary.") {
		t.Fatalf("system prompt missing stage instructions:\n%s", fake.taskCtx.SystemPrompt)
	}
	if !strings.Contains(fake.taskCtx.SystemPrompt, "summary (string) - Final summary") {
		t.Fatalf("system prompt missing field schema:\n%s", fake.taskCtx.SystemPrompt)
	}
	if !strings.Contains(fake.taskCtx.UserPrompt, `"request": "ship"`) {
		t.Fatalf("user prompt missing current fields:\n%s", fake.taskCtx.UserPrompt)
	}
	if _, ok := fake.taskCtx.Tools["set_field"]; !ok {
		t.Fatalf("expected set_field tool")
	}
	if _, ok := fake.taskCtx.Tools["request_transition"]; !ok {
		t.Fatalf("expected request_transition tool")
	}
	if _, ok := fake.taskCtx.Tools["block"]; ok {
		t.Fatalf("did not expect block tool when stage tools restrict it")
	}
	enum := fake.taskCtx.Tools["set_field"].InputSchema.(map[string]interface{})["properties"].(map[string]interface{})["field"].(map[string]interface{})["enum"].([]string)
	if len(enum) != 1 || enum[0] != "summary" {
		t.Fatalf("expected set_field enum [summary], got %#v", enum)
	}
}

func seedTask(t *testing.T, ds *DaemonScheduler, task workflow.Task) {
	t.Helper()
	created, err := ds.events.Append(task.ID, []workflow.NewEvent{{
		Type:   workflow.TaskEventCreated,
		Source: "user",
		Payload: map[string]interface{}{
			"taskId":          task.ID,
			"projectId":       task.ProjectID,
			"workflowId":      task.WorkflowID,
			"workflowVersion": task.WorkflowVersion,
			"stageId":         task.StageID,
			"fields":          task.Fields,
		},
	}})
	if err != nil {
		t.Fatalf("append created event failed: %v", err)
	}
	task.CreatedAt = created[0].TS
	task.UpdatedAt = created[0].TS
	if err := ds.projections.Put(task); err != nil {
		t.Fatalf("put projection failed: %v", err)
	}
}

func contextWorkflow() workflow.WorkflowDef {
	return workflow.WorkflowDef{
		ID:          "ctx",
		Version:     "1",
		Name:        "Context",
		Description: "context test workflow",
		Fields: map[string]workflow.FieldDef{
			"request": {Type: "string", Description: "Original request"},
			"summary": {Type: "string", Description: "Final summary"},
		},
		Stages: []workflow.StageDef{
			{
				ID:           "draft",
				Category:     workflow.StageCategoryInProgress,
				Entry:        workflow.Guard{Op: "always"},
				Instructions: "Draft the final summary.",
				Effort:       "high",
				OutputFields: []string{"summary"},
				Tools:        []string{"set_field", "request_transition"},
			},
			{
				ID:       "done",
				Category: workflow.StageCategoryDone,
				Entry:    workflow.Guard{Op: "hasEvent", EventType: workflow.TaskEventTransitionRequested},
			},
		},
	}
}

func customWorkflow() workflow.WorkflowDef {
	return workflow.WorkflowDef{
		ID:          "custom",
		Version:     "1",
		Name:        "Custom",
		Description: "custom test workflow",
		Fields: map[string]workflow.FieldDef{
			"approved": {Type: "boolean", Description: "approval flag"},
		},
		Stages: []workflow.StageDef{
			{ID: "open", Category: workflow.StageCategoryInProgress, Entry: workflow.Guard{Op: "always"}},
			{
				ID:       "done",
				Category: workflow.StageCategoryDone,
				Entry: workflow.Guard{
					Op: "and",
					All: []workflow.Guard{
						{Op: "field", Field: "approved", Cmp: "eq", Value: true},
						{Op: "hasEvent", EventType: workflow.TaskEventTransitionRequested},
					},
				},
			},
		},
	}
}
