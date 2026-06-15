// Package store implements the storage interfaces for sikong, mirroring
// packages/sikong/src/store/types.ts. Includes JSONL-backed implementations
// for EventStore, ChronicleStore, and YAML-backed implementations for
// WorkerStore and ProjectStore.
package store

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/esengine/sikong/internal/workflow"
)

const lockStaleMS = 5 * 60 * 1000

// readJSONL reads a JSONL file, tolerating a torn final line.
func readJSONL[T any](path string) ([]T, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	var items []T
	scanner := bufio.NewScanner(f)
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var item T
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			// If this is the last line and it's broken, tolerate it (crash mid-append)
			if !scanner.Scan() {
				break // torn tail
			}
			return nil, fmt.Errorf("corrupt JSONL at %s:%d: %w", path, lineNum, err)
		}
		items = append(items, item)
	}
	return items, scanner.Err()
}

// maxSeq finds the maximum seq in a slice of items with a Seq field.
func maxSeq[T interface{ GetSeq() int }](items []T) int {
	m := 0
	for _, item := range items {
		if s := item.GetSeq(); s > m {
			m = s
		}
	}
	return m
}

// withFileLock provides cross-process locking via a directory-based lock.
func withFileLock(target string, fn func() error) error {
	lockDir := target + ".lock"
	for attempt := 0; attempt < 2; attempt++ {
		err := os.Mkdir(lockDir, 0755)
		if err == nil {
			// Got the lock
			ownerPath := filepath.Join(lockDir, "owner.json")
			ownerData, _ := json.Marshal(map[string]interface{}{
				"pid": os.Getpid(),
				"ts":  time.Now().UnixMilli(),
			})
			os.WriteFile(ownerPath, ownerData, 0644)

			err := fn()

			os.RemoveAll(lockDir)
			return err
		}
		if !os.IsExist(err) {
			return err
		}
		// Lock exists — check stale
		stale, sErr := isStaleLock(lockDir)
		if sErr != nil {
			return sErr
		}
		if stale && attempt == 0 {
			os.RemoveAll(lockDir)
			continue
		}
		return fmt.Errorf("file %s is locked", target)
	}
	return fmt.Errorf("file %s: could not acquire lock", target)
}

func isStaleLock(lockDir string) (bool, error) {
	ownerPath := filepath.Join(lockDir, "owner.json")
	data, err := os.ReadFile(ownerPath)
	if err != nil {
		if os.IsNotExist(err) {
			return true, nil
		}
		return false, err
	}
	var owner struct {
		PID int   `json:"pid"`
		TS  int64 `json:"ts"`
	}
	if err := json.Unmarshal(data, &owner); err != nil {
		// Can't parse owner info — stale
		return true, nil
	}
	if time.Since(time.UnixMilli(owner.TS)) > lockStaleMS {
		return true, nil
	}
	// Check if the pid is alive
	if owner.PID > 0 && isPIDAlive(owner.PID) {
		return false, nil
	}
	return true, nil
}

func isPIDAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// On Unix, FindProcess always succeeds; Send signal 0 to check
	return process.Signal(os.Signal(nil)) == nil
}

// ── seq tracking ───────────────────────────────────────────────────────────

type seqItem struct {
	Seq int `json:"seq"`
}

func (s seqItem) GetSeq() int { return s.Seq }

type eventItem struct {
	workflow.TaskEvent
}

func (e eventItem) GetSeq() int { return e.Seq }

type chronicleItem struct {
	Seq int `json:"seq"`
}

func (c chronicleItem) GetSeq() int { return c.Seq }

// ── EventStore ──────────────────────────────────────────────────────────────

// JSONLEventStore implements EventStore using per-task JSONL files.
type JSONLEventStore struct {
	dir string
	mu  sync.Mutex // in-process serialization
}

func NewJSONLEventStore(dir string) *JSONLEventStore {
	return &JSONLEventStore{dir: dir}
}

func (s *JSONLEventStore) eventFile(taskID string) string {
	return filepath.Join(s.dir, "events", sanitize(taskID)+".jsonl")
}

func (s *JSONLEventStore) eventFileInState(stateDir, taskID string) string {
	return filepath.Join(stateDir, "events", sanitize(taskID)+".jsonl")
}

func projectIDFromEvents(events []workflow.NewEvent) string {
	for _, event := range events {
		if event.Type != workflow.TaskEventCreated {
			continue
		}
		if projectID, ok := event.Payload["projectId"].(string); ok && projectID != "" {
			return projectID
		}
	}
	return ""
}

func (s *JSONLEventStore) locateStateDir(taskID string) (string, bool, error) {
	dirs, err := listProjectStateDirs(s.dir)
	if err != nil {
		return "", false, err
	}
	for _, dir := range dirs {
		items, err := readJSONL[eventItem](s.eventFileInState(dir, taskID))
		if err != nil {
			return "", false, err
		}
		if len(items) > 0 {
			return dir, true, nil
		}
	}
	items, err := readJSONL[eventItem](s.eventFile(taskID))
	if err != nil {
		return "", false, err
	}
	if len(items) > 0 {
		return s.dir, true, nil
	}
	return "", false, nil
}

func (s *JSONLEventStore) Append(taskID string, events []workflow.NewEvent) ([]workflow.TaskEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	stateDir, found, err := s.locateStateDir(taskID)
	if err != nil {
		return nil, err
	}
	if !found {
		projectID := projectIDFromEvents(events)
		if projectID == "" {
			projectID = "default"
		}
		stateDir = projectStateDir(s.dir, projectID)
	}
	file := s.eventFileInState(stateDir, taskID)
	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		return nil, fmt.Errorf("mkdir events: %w", err)
	}
	var stamped []workflow.TaskEvent

	err = withFileLock(file, func() error {
		existing, err := readJSONL[eventItem](file)
		if err != nil {
			return err
		}
		base := maxSeq(existing)
		now := time.Now().UnixMilli()
		for i, e := range events {
			stamped = append(stamped, workflow.TaskEvent{
				Seq:     base + i + 1,
				TaskID:  taskID,
				Type:    e.Type,
				Payload: e.Payload,
				Source:  e.Source,
				WakeID:  e.WakeID,
				TS:      now,
			})
		}

		// Append to file
		f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			return fmt.Errorf("open event file: %w", err)
		}
		defer f.Close()

		for _, ev := range stamped {
			data, err := json.Marshal(ev)
			if err != nil {
				return fmt.Errorf("marshal event: %w", err)
			}
			if _, err := f.Write(data); err != nil {
				return fmt.Errorf("write event: %w", err)
			}
			if _, err := f.Write([]byte("\n")); err != nil {
				return fmt.Errorf("write newline: %w", err)
			}
		}
		return nil
	})

	if err != nil {
		return nil, err
	}
	return stamped, nil
}

func (s *JSONLEventStore) Load(taskID string, fromSeq int) ([]workflow.TaskEvent, error) {
	stateDir, found, err := s.locateStateDir(taskID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	items, err := readJSONL[eventItem](s.eventFileInState(stateDir, taskID))
	if err != nil {
		return nil, err
	}
	var events []workflow.TaskEvent
	for _, item := range items {
		if item.Seq > fromSeq {
			events = append(events, item.TaskEvent)
		}
	}
	return events, nil
}

// sanitize replaces unsafe filename characters.
func sanitize(id string) string {
	return strings.NewReplacer(
		"/", "_",
		"\\", "_",
		":", "_",
		"*", "_",
		"?", "_",
		"\"", "_",
		"<", "_",
		">", "_",
		"|", "_",
	).Replace(id)
}

// sortEvents sorts by seq, then ts.
func sortEvents(events []workflow.TaskEvent) {
	sort.Slice(events, func(i, j int) bool {
		if events[i].Seq != events[j].Seq {
			return events[i].Seq < events[j].Seq
		}
		return events[i].TS < events[j].TS
	})
}
