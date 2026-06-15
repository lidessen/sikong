package main

import (
	"fmt"
	"strings"

	"github.com/esengine/sikong/internal/protocol"
	"github.com/esengine/sikong/internal/workflow"
)

func reduceWakeCommands(task workflow.Task, wf workflow.WorkflowDef, commands []protocol.WakeCommand, wakeID string) ([]workflow.NewEvent, error) {
	if task.Status.Terminal() {
		return nil, fmt.Errorf("task %s is %s and accepts no further commands", task.ID, task.Status)
	}

	var out []workflow.NewEvent
	for _, command := range commands {
		switch command.Kind {
		case "set_field":
			field := strings.TrimSpace(command.Field)
			if field == "" {
				return nil, fmt.Errorf("set_field requires field")
			}
			def, ok := wf.Fields[field]
			if !ok {
				return nil, fmt.Errorf("unknown field %q", field)
			}
			if !workflow.ValidateFieldValue(def, command.Value) {
				return nil, fmt.Errorf("value for %q is not a valid %s", field, def.Type)
			}
			out = append(out, workflow.NewEvent{
				Type:   workflow.TaskEventFieldSet,
				Source: "worker",
				WakeID: wakeID,
				Payload: map[string]interface{}{
					"field": field,
					"value": command.Value,
				},
			})
		case "request_transition":
			payload := map[string]interface{}{"fromStage": task.StageID}
			if strings.TrimSpace(command.Reason) != "" {
				payload["reason"] = command.Reason
			}
			out = append(out, workflow.NewEvent{
				Type:    workflow.TaskEventTransitionRequested,
				Source:  "worker",
				WakeID:  wakeID,
				Payload: payload,
			})
		case "append_note":
			text := strings.TrimSpace(command.Text)
			if text == "" {
				return nil, fmt.Errorf("append_note requires text")
			}
			out = append(out, workflow.NewEvent{
				Type:   workflow.TaskEventNoteAppended,
				Source: "worker",
				WakeID: wakeID,
				Payload: map[string]interface{}{
					"text": text,
				},
			})
		case "block":
			reason := strings.TrimSpace(command.Reason)
			if reason == "" {
				return nil, fmt.Errorf("block requires reason")
			}
			out = append(out, workflow.NewEvent{
				Type:   workflow.TaskEventBlocked,
				Source: "worker",
				WakeID: wakeID,
				Payload: map[string]interface{}{
					"reason": reason,
				},
			})
		case "cancel":
			payload := map[string]interface{}{}
			if strings.TrimSpace(command.Reason) != "" {
				payload["reason"] = command.Reason
			}
			out = append(out, workflow.NewEvent{
				Type:    workflow.TaskEventCancellationRequested,
				Source:  "worker",
				WakeID:  wakeID,
				Payload: payload,
			})
		default:
			return nil, fmt.Errorf("unsupported wake command %q", command.Kind)
		}
	}

	return out, nil
}

func applyWakeEvents(task workflow.Task, wf workflow.WorkflowDef, events []workflow.TaskEvent) workflow.Task {
	for _, event := range events {
		if task.Status.Terminal() {
			break
		}
		switch event.Type {
		case workflow.TaskEventFieldSet:
			field, _ := event.Payload["field"].(string)
			if field == "" {
				continue
			}
			if task.Fields == nil {
				task.Fields = map[string]interface{}{}
			}
			task.Fields[field] = event.Payload["value"]
		case workflow.TaskEventStageEntered:
			stageID, _ := event.Payload["stageId"].(string)
			if stageID == "" {
				continue
			}
			task.StageID = stageID
			if task.Status != workflow.TaskStatusBlocked {
				task.Status = workflow.StatusForStage(wf, stageID)
			}
		case workflow.TaskEventBlocked:
			task.Status = workflow.TaskStatusBlocked
		case workflow.TaskEventCancelled:
			task.Status = workflow.TaskStatusCancelled
		}
		if event.TS != 0 {
			task.UpdatedAt = event.TS
		}
	}
	return task
}
