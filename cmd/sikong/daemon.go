package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/esengine/sikong/internal/protocol"
	"github.com/esengine/sikong/internal/store"
	"github.com/esengine/sikong/internal/workflow"
)

type WakeRunner interface {
	RunWake(workerCfg protocol.WakeWorkerConfig, taskCtx protocol.WakeTaskContext) (*protocol.RunWakeResult, error)
	Close() error
}

// WorkerHost manages a pool of Bun worker-host subprocesses.
type WorkerHost struct {
	cmd     *exec.Cmd
	stdin   *json.Encoder
	stdout  *bufio.Scanner
	mu      sync.Mutex
	nextID  int
	pending map[int]chan<- json.RawMessage
	closed  bool
}

// NewWorkerHost starts a new sikong-worker subprocess.
func NewWorkerHost(workerScript string) (*WorkerHost, error) {
	cmd := exec.Command("bun", workerScript)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	cmd.Stderr = os.Stderr

	wh := &WorkerHost{
		cmd:     cmd,
		stdin:   json.NewEncoder(stdin),
		pending: make(map[int]chan<- json.RawMessage),
	}

	scanner := bufio.NewScanner(stdout)
	wh.stdout = scanner

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start worker: %w", err)
	}

	// Read responses in background
	go wh.readLoop(scanner)

	// Wait for initialize notification
	time.Sleep(100 * time.Millisecond)

	return wh, nil
}

func (wh *WorkerHost) readLoop(scanner *bufio.Scanner) {
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var msg struct {
			ID     int                `json:"id"`
			Method string             `json:"method"`
			Result json.RawMessage    `json:"result"`
			Error  *protocol.RpcError `json:"error"`
		}
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue
		}
		if msg.Method != "" || msg.ID == 0 {
			// Notification (initialize, wake events) — ignore for now
			continue
		}
		wh.mu.Lock()
		ch, ok := wh.pending[msg.ID]
		if ok {
			delete(wh.pending, msg.ID)
		}
		wh.mu.Unlock()
		if ok && ch != nil {
			ch <- msg.Result
		}
	}
}

// RunWake sends a runWake request to the worker subprocess and returns the result.
func (wh *WorkerHost) RunWake(workerCfg protocol.WakeWorkerConfig, taskCtx protocol.WakeTaskContext) (*protocol.RunWakeResult, error) {
	wh.mu.Lock()
	wh.nextID++
	id := wh.nextID
	ch := make(chan json.RawMessage, 1)
	wh.pending[id] = ch
	wh.mu.Unlock()

	req := protocol.JsonRpcMessage{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "runWake",
		Params: protocol.RunWakeParams{
			Worker: workerCfg,
			Task:   taskCtx,
		},
	}

	if err := wh.stdin.Encode(req); err != nil {
		return nil, fmt.Errorf("send runWake: %w", err)
	}

	select {
	case raw := <-ch:
		var result protocol.RunWakeResult
		if err := json.Unmarshal(raw, &result); err != nil {
			return nil, fmt.Errorf("parse result: %w", err)
		}
		return &result, nil
	case <-time.After(10 * time.Minute):
		return nil, fmt.Errorf("runWake timeout")
	}
}

// Close terminates the worker subprocess.
func (wh *WorkerHost) Close() error {
	wh.mu.Lock()
	wh.closed = true
	wh.mu.Unlock()
	return wh.cmd.Process.Kill()
}

// ── DaemonScheduler ────────────────────────────────────────────────────────

// DaemonScheduler manages task execution and worker-host lifecycle.
type DaemonScheduler struct {
	dir         string
	events      *store.JSONLEventStore
	projections *store.JSONProjectionStore
	chronicle   *store.JSONLChronicleStore
	worker      WakeRunner
	tasks       map[string]*runningTask
	mu          sync.Mutex
}

type runningTask struct {
	TaskID    string
	StartedAt time.Time
	Cancel    func()
}

func NewDaemonScheduler(dir string) (*DaemonScheduler, error) {
	ds := &DaemonScheduler{
		dir:         dir,
		events:      store.NewJSONLEventStore(dir),
		projections: store.NewJSONProjectionStore(dir),
		chronicle:   store.NewJSONLChronicleStore(dir),
		tasks:       make(map[string]*runningTask),
	}
	return ds, nil
}

func (ds *DaemonScheduler) StartWorker() error {
	script := "packages/sikong/src/worker-host.ts"
	// Try to find the script relative to the module root
	if _, err := os.Stat(script); os.IsNotExist(err) {
		// Try common locations
		altPaths := []string{
			"../../packages/sikong/src/worker-host.ts",
			"../packages/sikong/src/worker-host.ts",
		}
		for _, p := range altPaths {
			if _, err := os.Stat(p); err == nil {
				script = p
				break
			}
		}
	}
	w, err := NewWorkerHost(script)
	if err != nil {
		return fmt.Errorf("start worker: %w", err)
	}
	ds.worker = w
	return nil
}

func (ds *DaemonScheduler) Stop() {
	if ds.worker != nil {
		ds.worker.Close()
	}
}

func (ds *DaemonScheduler) childStatuses(task workflow.Task) ([]workflow.TaskStatus, error) {
	if len(task.ChildIDs) == 0 {
		return nil, nil
	}
	statuses := make([]workflow.TaskStatus, 0, len(task.ChildIDs))
	for _, childID := range task.ChildIDs {
		child, err := ds.projections.Get(childID)
		if err != nil {
			return nil, fmt.Errorf("load child %s: %w", childID, err)
		}
		if child == nil {
			statuses = append(statuses, workflow.TaskStatusTodo)
			continue
		}
		statuses = append(statuses, child.Status)
	}
	return statuses, nil
}

// ExecuteWake runs one wake for a task by spawning a worker-host subprocess
// with the task context and worker config.
func (ds *DaemonScheduler) ExecuteWake(taskID string) error {
	// Load task and events
	task, err := ds.projections.Get(taskID)
	if err != nil {
		return fmt.Errorf("load task: %w", err)
	}
	if task == nil {
		return fmt.Errorf("task %s not found", taskID)
	}

	events, err := ds.events.Load(taskID, 0)
	if err != nil {
		return fmt.Errorf("load events: %w", err)
	}

	registry := store.NewJSONWorkflowRegistry(ds.dir)
	wf, err := registry.Get(task.WorkflowID, task.WorkflowVersion)
	if err != nil {
		return fmt.Errorf("load workflow: %w", err)
	}
	if wf == nil {
		return fmt.Errorf("workflow %s@%s not found", task.WorkflowID, task.WorkflowVersion)
	}

	// Build worker config (simplified — use DeepSeek over ai-sdk)
	workerCfg := protocol.WakeWorkerConfig{
		Runtime: "ai-sdk",
		Provider: protocol.WorkerProviderConfig{
			ID:    "deepseek",
			Model: "deepseek-v4-flash",
		},
	}

	taskCtx := buildWakeTaskContext(*task, *wf)

	if ds.worker == nil {
		return fmt.Errorf("worker not started")
	}

	wakeID := fmt.Sprintf("wake_%d", time.Now().UnixNano())

	// Record wake start in chronicle
	ds.chronicle.Append(store.ChronicleEntry{
		Type:    store.ChronicleWakeStart,
		TaskID:  taskID,
		WakeID:  wakeID,
		Summary: fmt.Sprintf("wake started: stage=%s", task.StageID),
	})

	start := time.Now()
	result, err := ds.worker.RunWake(workerCfg, taskCtx)
	duration := time.Since(start)

	if err != nil {
		ds.chronicle.Append(store.ChronicleEntry{
			Type:    store.ChronicleWakeError,
			TaskID:  taskID,
			WakeID:  wakeID,
			Summary: fmt.Sprintf("wake failed: %v", err),
		})
		return err
	}

	if len(result.Commands) > 0 {
		newEvents, err := reduceWakeCommands(*task, *wf, result.Commands, wakeID)
		if err != nil {
			ds.chronicle.Append(store.ChronicleEntry{
				Type:    store.ChronicleCommandRejected,
				TaskID:  taskID,
				WakeID:  wakeID,
				Summary: fmt.Sprintf("wake command rejected: %v", err),
				Data:    map[string]interface{}{"commands": result.Commands},
			})
			return err
		}
		stamped, err := ds.events.Append(taskID, newEvents)
		if err != nil {
			return fmt.Errorf("append wake events: %w", err)
		}
		updated := applyWakeEvents(*task, *wf, stamped)
		if err := ds.projections.Put(updated); err != nil {
			return fmt.Errorf("put wake projection: %w", err)
		}
		task = &updated
		events = append(events, stamped...)
	}

	children, err := ds.childStatuses(*task)
	if err != nil {
		return err
	}
	advanceEvents := workflow.TryAdvance(*task, *wf, events, children, wakeID)
	if len(advanceEvents) > 0 {
		stamped, err := ds.events.Append(taskID, advanceEvents)
		if err != nil {
			return fmt.Errorf("append advance events: %w", err)
		}
		updated := applyWakeEvents(*task, *wf, stamped)
		if err := ds.projections.Put(updated); err != nil {
			return fmt.Errorf("put advanced projection: %w", err)
		}
		task = &updated
		events = append(events, stamped...)
	}

	// Record in chronicle
	wakeType := store.ChronicleWakeEnd
	summary := fmt.Sprintf("wake done — status=%s (%s)", result.Status, duration.Round(time.Millisecond))
	if result.Error != "" {
		wakeType = store.ChronicleWakeError
		summary = fmt.Sprintf("wake failed: %s", result.Error)
	}

	ds.chronicle.Append(store.ChronicleEntry{
		Type:    wakeType,
		TaskID:  taskID,
		WakeID:  wakeID,
		Summary: summary,
		Data: map[string]interface{}{
			"durationMs": duration.Milliseconds(),
			"usage":      result.Usage,
			"commands":   len(result.Commands),
			"stageId":    task.StageID,
			"status":     task.Status,
		},
	})

	return nil
}
