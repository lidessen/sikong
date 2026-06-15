package workflow

import "testing"

func TestTryAdvanceUsesCurrentStageEventsOnly(t *testing.T) {
	wf := WorkflowDef{
		ID:          "leak",
		Version:     "1",
		Name:        "Leak",
		Description: "guard leak test",
		Fields:      map[string]FieldDef{},
		Stages: []StageDef{
			{ID: "a", Category: StageCategoryInProgress, Entry: Guard{Op: "always"}},
			{ID: "b", Category: StageCategoryInProgress, Entry: Guard{Op: "hasEvent", EventType: TaskEventTransitionRequested}},
			{ID: "c", Category: StageCategoryDone, Entry: Guard{Op: "hasEvent", EventType: TaskEventTransitionRequested}},
		},
	}
	task := Task{
		ID:              "t",
		ProjectID:       "p",
		WorkflowID:      "leak",
		WorkflowVersion: "1",
		StageID:         "a",
		Status:          TaskStatusInProgress,
		Fields:          map[string]interface{}{},
	}
	events := []TaskEvent{
		{Seq: 1, Type: TaskEventCreated, TaskID: "t"},
		{Seq: 2, Type: TaskEventTransitionRequested, TaskID: "t"},
	}

	advance := TryAdvance(task, wf, events, nil, "wake_1")
	if len(advance) != 1 {
		t.Fatalf("expected one advance event, got %#v", advance)
	}
	if advance[0].Payload["stageId"] != "b" {
		t.Fatalf("expected stage b, got %#v", advance[0].Payload["stageId"])
	}
}

func TestEvalGuardFieldComparisonsFailClosed(t *testing.T) {
	env := GuardEnv{
		Fields: map[string]interface{}{
			"score": 7.0,
			"label": "b",
		},
		EventTypes: map[TaskEventType]bool{},
	}

	if !EvalGuard(Guard{Op: "field", Field: "score", Cmp: "gte", Value: 5.0}, env) {
		t.Fatalf("expected score gte guard to pass")
	}
	if !EvalGuard(Guard{Op: "field", Field: "label", Cmp: "in", Value: []interface{}{"a", "b"}}, env) {
		t.Fatalf("expected label in guard to pass")
	}
	if EvalGuard(Guard{Op: "field", Field: "label", Cmp: "gt", Value: 1.0}, env) {
		t.Fatalf("expected malformed numeric comparison to fail closed")
	}
}
