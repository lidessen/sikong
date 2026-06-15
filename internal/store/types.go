// Package store defines the storage interfaces for sikong, mirroring
// packages/sikong/src/store/types.ts.
package store

import (
	"github.com/esengine/sikong/internal/workflow"
)

// EventStore is the append-only event log — the system of record.
type EventStore interface {
	// Append events for a task; stamps them with seq + ts.
	Append(taskID string, events []workflow.NewEvent) ([]workflow.TaskEvent, error)
	// Load a task's timeline, optionally only events with seq > fromSeq.
	Load(taskID string, fromSeq int) ([]workflow.TaskEvent, error)
}

// ProjectionStore is the queryable read side: current task projections.
type ProjectionStore interface {
	Get(taskID string) (*workflow.Task, error)
	Put(task workflow.Task) error
	Query(filter TaskQuery) ([]workflow.Task, error)
}

// ChronicleType describes workspace-level observability record type.
type ChronicleType string

const (
	ChronicleTaskCreated     ChronicleType = "task.created"
	ChronicleIntakeRouted    ChronicleType = "intake.routed"
	ChronicleWakeStart       ChronicleType = "wake.start"
	ChronicleWakeProgress    ChronicleType = "wake.progress"
	ChronicleWakeWaiting     ChronicleType = "wake.waiting"
	ChronicleWakeSteer       ChronicleType = "wake.steer"
	ChronicleWakeDiagnostics ChronicleType = "wake.diagnostics"
	ChronicleWakeCommit      ChronicleType = "wake.commit"
	ChronicleWakeReviewReq   ChronicleType = "wake.review_required"
	ChronicleWakeCleanup     ChronicleType = "wake.cleanup"
	ChronicleWakeEnd         ChronicleType = "wake.end"
	ChronicleWakeError       ChronicleType = "wake.error"
	ChronicleLeadMessage     ChronicleType = "lead.message"
	ChronicleTaskAdvanced    ChronicleType = "task.advanced"
	ChronicleTaskTerminal    ChronicleType = "task.terminal"
	ChronicleCommandRejected ChronicleType = "command.rejected"
)

// ChronicleEntry is a workspace-level observability record.
type ChronicleEntry struct {
	Seq     int                    `json:"seq"`
	TS      int64                  `json:"ts"`
	Type    ChronicleType          `json:"type"`
	TaskID  string                 `json:"taskId,omitempty"`
	WakeID  string                 `json:"wakeId,omitempty"`
	Summary string                 `json:"summary"`
	Data    map[string]interface{} `json:"data,omitempty"`
}

// ChronicleQuery filters chronicle entries.
type ChronicleQuery struct {
	Limit  int
	TaskID string
	Type   ChronicleType
}

// ChronicleStore is the append-only observability log.
type ChronicleStore interface {
	Append(entry ChronicleEntry) (ChronicleEntry, error)
	Recent(query ChronicleQuery) ([]ChronicleEntry, error)
}

// TaskQuery filters task projections.
type TaskQuery struct {
	ProjectID  string
	WorkflowID string
	Status     workflow.TaskStatus
	ParentID   string
}

// Worker describes a hireable agent configuration.
type Worker struct {
	ID             string   `json:"id" yaml:"id"`
	Name           string   `json:"name" yaml:"name"`
	Description    string   `json:"description" yaml:"description"`
	Runtime        string   `json:"runtime" yaml:"runtime"`
	Provider       string   `json:"provider" yaml:"provider"`
	Model          string   `json:"model" yaml:"model"`
	PermissionMode string   `json:"permissionMode,omitempty" yaml:"permissionMode,omitempty"`
	Roles          []string `json:"roles,omitempty" yaml:"roles,omitempty"`
}

// WorkerStore is the durable roster of Workers.
type WorkerStore interface {
	Get(id string) (*Worker, error)
	Put(worker Worker) error
	List() ([]Worker, error)
}

// LeadConfig specifies the project's lead agent configuration.
type LeadConfig struct {
	Backend string `json:"backend" yaml:"backend"`
	Model   string `json:"model,omitempty" yaml:"model,omitempty"`
}

// Project is the container every task lives under.
type Project struct {
	ID               string      `json:"id" yaml:"id"`
	Name             string      `json:"name" yaml:"name"`
	Root             string      `json:"root" yaml:"root"`
	DefaultWorkflow  string      `json:"defaultWorkflow,omitempty" yaml:"defaultWorkflow,omitempty"`
	DefaultWorker    string      `json:"defaultWorker,omitempty" yaml:"defaultWorker,omitempty"`
	PermissionMode   string      `json:"permissionMode,omitempty" yaml:"permissionMode,omitempty"`
	Lead             *LeadConfig `json:"lead,omitempty" yaml:"lead,omitempty"`
}

// ProjectStore is the durable store of Projects.
type ProjectStore interface {
	Get(id string) (*Project, error)
	Put(project Project) error
	List() ([]Project, error)
}

// WorkflowDef is the serializable workflow definition.
type WorkflowDef struct {
	ID          string                 `json:"id" yaml:"id"`
	Version     string                 `json:"version" yaml:"version"`
	Name        string                 `json:"name" yaml:"name"`
	Description string                 `json:"description" yaml:"description"`
	WorkerRole  string                 `json:"workerRole,omitempty" yaml:"workerRole,omitempty"`
	Fields      map[string]interface{} `json:"fields" yaml:"fields"`
	Stages      []interface{}          `json:"stages" yaml:"stages"`
}

// WorkflowRegistry holds workflow definitions and routes requests to them.
type WorkflowRegistry interface {
	Register(def WorkflowDef) error
	Get(id string, version string) (*WorkflowDef, error)
	Match(input string) (*WorkflowDef, error)
	List() ([]WorkflowDef, error)
}
