// Package workflow holds the domain type definitions for sikong, matching
// the TypeScript types in packages/sikong/src/workflow/types.ts.
package workflow

// TaskStatus represents the lifecycle status of a workflow task.
type TaskStatus string

const (
	TaskStatusTodo       TaskStatus = "todo"
	TaskStatusInProgress TaskStatus = "in_progress"
	TaskStatusDone       TaskStatus = "done"
	TaskStatusCancelled  TaskStatus = "cancelled"
	TaskStatusBlocked    TaskStatus = "blocked"
)

// Terminal returns true if the status is absorbing (done or cancelled).
func (s TaskStatus) Terminal() bool {
	return s == TaskStatusDone || s == TaskStatusCancelled
}

// TaskEventType represents the type of an event in a task's timeline.
type TaskEventType string

const (
	TaskEventCreated               TaskEventType = "task.created"
	TaskEventQueued                TaskEventType = "task.queued"
	TaskEventClaimed               TaskEventType = "task.claimed"
	TaskEventRunning               TaskEventType = "task.running"
	TaskEventProgress              TaskEventType = "task.progress"
	TaskEventEvidence              TaskEventType = "task.evidence"
	TaskEventSucceeded             TaskEventType = "task.succeeded"
	TaskEventFailed                TaskEventType = "task.failed"
	TaskEventCancelled             TaskEventType = "task.cancelled"
	TaskEventTimedOut              TaskEventType = "task.timed_out"
	TaskEventRetried               TaskEventType = "task.retried"
	TaskEventSteerRequested        TaskEventType = "task.steer_requested"
	TaskEventSteerAck              TaskEventType = "task.steer_ack"
	TaskEventFieldSet              TaskEventType = "field.set"
	TaskEventTransitionRequested   TaskEventType = "transition.requested"
	TaskEventStageEntered          TaskEventType = "stage.entered"
	TaskEventNoteAppended          TaskEventType = "note.appended"
	TaskEventSubtaskCreated        TaskEventType = "subtask.created"
	TaskEventBlocked               TaskEventType = "task.blocked"
	TaskEventUnblocked             TaskEventType = "task.unblocked"
	TaskEventCancellationRequested TaskEventType = "cancellation.requested"
)

// TaskScopes declares the scopes a task needs for lease-based scheduling.
type TaskScopes struct {
	Read  []string `json:"read,omitempty"`
	Write []string `json:"write,omitempty"`
}

// Task is a projection over a workflow instance's event timeline.
type Task struct {
	ID              string                 `json:"id"`
	ProjectID       string                 `json:"projectId"`
	WorkflowID      string                 `json:"workflowId"`
	WorkflowVersion string                 `json:"workflowVersion"`
	ParentID        string                 `json:"parentId,omitempty"`
	Depth           int                    `json:"depth"`
	WorkerID        string                 `json:"workerId,omitempty"`
	StageID         string                 `json:"stageId"`
	Status          TaskStatus             `json:"status"`
	Fields          map[string]interface{} `json:"fields"`
	ChildIDs        []string               `json:"childIds,omitempty"`
	DependsOn       []string               `json:"dependsOn,omitempty"`
	Scopes          *TaskScopes            `json:"scopes,omitempty"`
	Isolate         bool                   `json:"isolate,omitempty"`
	Effort          string                 `json:"effort,omitempty"`
	CreatedAt       int64                  `json:"createdAt"`
	UpdatedAt       int64                  `json:"updatedAt"`
}

// TaskEvent is one event in a task's append-only event timeline.
type TaskEvent struct {
	Seq         int                    `json:"seq"`
	IDemKey     string                 `json:"idempotencyKey,omitempty"`
	TaskID      string                 `json:"taskId"`
	WorkspaceID string                 `json:"workspaceId,omitempty"`
	NodeID      string                 `json:"nodeId,omitempty"`
	Type        TaskEventType          `json:"type"`
	Payload     map[string]interface{} `json:"payload,omitempty"`
	Data        map[string]interface{} `json:"data,omitempty"`
	Source      string                 `json:"source,omitempty"`
	WakeID      string                 `json:"wakeId,omitempty"`
	TS          int64                  `json:"ts"`
}

// NewEvent is a TaskEvent before the store stamps it with seq and ts.
type NewEvent struct {
	Type    TaskEventType          `json:"type"`
	Payload map[string]interface{} `json:"payload,omitempty"`
	Source  string                 `json:"source,omitempty"`
	WakeID  string                 `json:"wakeId,omitempty"`
}

// FieldDef describes one typed field on a WorkflowDef.
type FieldDef struct {
	Type        string   `json:"type"`
	Description string   `json:"description"`
	Enum        []string `json:"enum,omitempty"`
	Required    bool     `json:"required,omitempty"`
}

// Guard is a declarative stage admission predicate.
type Guard struct {
	Op        string        `json:"op" yaml:"op"`
	Field     string        `json:"field,omitempty" yaml:"field,omitempty"`
	Cmp       string        `json:"cmp,omitempty" yaml:"cmp,omitempty"`
	Value     interface{}   `json:"value,omitempty" yaml:"value,omitempty"`
	EventType TaskEventType `json:"eventType,omitempty" yaml:"eventType,omitempty"`
	All       []Guard       `json:"all,omitempty" yaml:"all,omitempty"`
	Any       []Guard       `json:"any,omitempty" yaml:"any,omitempty"`
	Guard     *Guard        `json:"guard,omitempty" yaml:"guard,omitempty"`
}

// StageCategory is the Kanban category derived from the stage.
type StageCategory string

const (
	StageCategoryTodo       StageCategory = "todo"
	StageCategoryInProgress StageCategory = "in_progress"
	StageCategoryDone       StageCategory = "done"
)

// StageDef is one ordered stage in a workflow definition.
type StageDef struct {
	ID              string        `json:"id" yaml:"id"`
	Category        StageCategory `json:"category" yaml:"category"`
	Entry           Guard         `json:"entry" yaml:"entry"`
	Skills          []string      `json:"skills,omitempty" yaml:"skills,omitempty"`
	Tools           []string      `json:"tools,omitempty" yaml:"tools,omitempty"`
	OutputFields    []string      `json:"outputFields,omitempty" yaml:"outputFields,omitempty"`
	Instructions    string        `json:"instructions,omitempty" yaml:"instructions,omitempty"`
	EscalateAfterMS int64         `json:"escalateAfterMs,omitempty" yaml:"escalateAfterMs,omitempty"`
	Effort          string        `json:"effort,omitempty" yaml:"effort,omitempty"`
}

// WorkflowDef is the registered, serializable workflow definition.
type WorkflowDef struct {
	ID           string              `json:"id" yaml:"id"`
	Version      string              `json:"version" yaml:"version"`
	Name         string              `json:"name" yaml:"name"`
	Description  string              `json:"description" yaml:"description"`
	WorkerRole   string              `json:"workerRole,omitempty" yaml:"workerRole,omitempty"`
	Fields       map[string]FieldDef `json:"fields" yaml:"fields"`
	Stages       []StageDef          `json:"stages" yaml:"stages"`
	MaxTeamDepth *int                `json:"maxTeamDepth,omitempty" yaml:"maxTeamDepth,omitempty"`
}
