package workflow

import "reflect"

type GuardEnv struct {
	Fields           map[string]interface{}
	EventTypes       map[TaskEventType]bool
	Children         []TaskStatus
	AcceptanceStatus string
}

func EvalGuard(guard Guard, env GuardEnv) bool {
	switch guard.Op {
	case "always":
		return true
	case "never":
		return false
	case "field":
		return compareField(env.Fields[guard.Field], guard.Cmp, guard.Value)
	case "hasEvent":
		return env.EventTypes[guard.EventType]
	case "childrenDone":
		for _, status := range env.Children {
			if !status.Terminal() {
				return false
			}
		}
		return true
	case "childrenSucceeded":
		for _, status := range env.Children {
			if status != TaskStatusDone {
				return false
			}
		}
		return true
	case "acceptancePassed":
		return env.AcceptanceStatus == "accepted"
	case "and":
		for _, child := range guard.All {
			if !EvalGuard(child, env) {
				return false
			}
		}
		return true
	case "or":
		for _, child := range guard.Any {
			if EvalGuard(child, env) {
				return true
			}
		}
		return false
	case "not":
		if guard.Guard == nil {
			return false
		}
		return !EvalGuard(*guard.Guard, env)
	default:
		return false
	}
}

func TryAdvance(task Task, wf WorkflowDef, events []TaskEvent, children []TaskStatus, wakeID string) []NewEvent {
	var out []NewEvent
	cur := task

	for hops := len(wf.Stages); hops > 0; hops-- {
		if cur.Status.Terminal() || cur.Status == TaskStatusBlocked {
			break
		}
		idx := stageIndex(wf, cur.StageID)
		if idx < 0 || idx+1 >= len(wf.Stages) {
			break
		}
		next := wf.Stages[idx+1]
		env := GuardEnv{
			Fields:           cur.Fields,
			EventTypes:       eventTypesInCurrentStage(events, out),
			Children:         children,
			AcceptanceStatus: deriveAcceptanceStatus(events, out),
		}
		if !EvalGuard(next.Entry, env) {
			break
		}

		ev := NewEvent{
			Type:   TaskEventStageEntered,
			Source: "engine",
			WakeID: wakeID,
			Payload: map[string]interface{}{
				"stageId": next.ID,
			},
		}
		out = append(out, ev)
		cur.StageID = next.ID
		if cur.Status != TaskStatusBlocked {
			cur.Status = StatusForStage(wf, next.ID)
		}
	}

	return out
}

func StatusForStage(wf WorkflowDef, stageID string) TaskStatus {
	stage := StageByID(wf, stageID)
	if stage == nil {
		return TaskStatusInProgress
	}
	switch stage.Category {
	case StageCategoryTodo:
		return TaskStatusTodo
	case StageCategoryDone:
		return TaskStatusDone
	default:
		return TaskStatusInProgress
	}
}

func StageByID(wf WorkflowDef, stageID string) *StageDef {
	for i := range wf.Stages {
		if wf.Stages[i].ID == stageID {
			return &wf.Stages[i]
		}
	}
	return nil
}

func ValidateFieldValue(def FieldDef, value interface{}) bool {
	switch def.Type {
	case "string", "ref":
		_, ok := value.(string)
		return ok
	case "number":
		switch value.(type) {
		case int, int64, float64, float32:
			return true
		default:
			return false
		}
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "enum":
		actual, ok := value.(string)
		if !ok {
			return false
		}
		for _, allowed := range def.Enum {
			if actual == allowed {
				return true
			}
		}
		return false
	case "json":
		return true
	default:
		return false
	}
}

func compareField(actual interface{}, cmp string, value interface{}) bool {
	switch cmp {
	case "exists":
		return actual != nil
	case "eq":
		return reflect.DeepEqual(actual, value)
	case "ne":
		return !reflect.DeepEqual(actual, value)
	case "in":
		items, ok := value.([]interface{})
		if !ok {
			return false
		}
		for _, item := range items {
			if reflect.DeepEqual(actual, item) {
				return true
			}
		}
		return false
	case "gt", "gte", "lt", "lte":
		a, aOK := asFloat(actual)
		b, bOK := asFloat(value)
		if !aOK || !bOK {
			return false
		}
		if cmp == "gt" {
			return a > b
		}
		if cmp == "gte" {
			return a >= b
		}
		if cmp == "lt" {
			return a < b
		}
		return a <= b
	default:
		return false
	}
}

func eventTypesInCurrentStage(events []TaskEvent, pending []NewEvent) map[TaskEventType]bool {
	var types []TaskEventType
	for _, event := range events {
		types = append(types, event.Type)
	}
	for _, event := range pending {
		types = append(types, event.Type)
	}

	start := 0
	for i := len(types) - 1; i >= 0; i-- {
		if types[i] == TaskEventStageEntered || types[i] == TaskEventCreated || types[i] == TaskEventUnblocked {
			start = i + 1
			break
		}
	}

	out := make(map[TaskEventType]bool)
	for _, eventType := range types[start:] {
		out[eventType] = true
	}
	return out
}

func deriveAcceptanceStatus(events []TaskEvent, pending []NewEvent) string {
	type eventView struct {
		Type TaskEventType
	}
	var all []eventView
	for _, event := range events {
		all = append(all, eventView{Type: event.Type})
	}
	for _, event := range pending {
		all = append(all, eventView{Type: event.Type})
	}
	sawEvidence := false
	for i := len(all) - 1; i >= 0; i-- {
		switch all[i].Type {
		case "acceptance.accepted":
			return "accepted"
		case "acceptance.rejected":
			return "rejected"
		case "acceptance.evidence":
			sawEvidence = true
		case TaskEventStageEntered, TaskEventCreated:
			if sawEvidence {
				return "pending"
			}
			return "none"
		}
	}
	if sawEvidence {
		return "pending"
	}
	return "none"
}

func stageIndex(wf WorkflowDef, stageID string) int {
	for i, stage := range wf.Stages {
		if stage.ID == stageID {
			return i
		}
	}
	return -1
}

func asFloat(value interface{}) (float64, bool) {
	switch v := value.(type) {
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case float64:
		return v, true
	case float32:
		return float64(v), true
	default:
		return 0, false
	}
}
