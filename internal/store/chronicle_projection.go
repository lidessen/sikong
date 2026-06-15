package store

import (
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

// JSONLChronicleStore implements ChronicleStore using a single JSONL file.
type JSONLChronicleStore struct {
	dir string
	mu  sync.Mutex
}

func NewJSONLChronicleStore(dir string) *JSONLChronicleStore {
	return &JSONLChronicleStore{dir: dir}
}

func (s *JSONLChronicleStore) file() string {
	return filepath.Join(workspaceStateDir(s.dir), "chronicle.jsonl")
}

func (s *JSONLChronicleStore) legacyFile() string {
	return filepath.Join(s.dir, "chronicle.jsonl")
}

func (s *JSONLChronicleStore) Append(entry ChronicleEntry) (ChronicleEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	file := s.file()
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		return entry, fmt.Errorf("mkdir chronicle: %w", err)
	}

	var full ChronicleEntry
	err := withFileLock(file, func() error {
		existing, err := readJSONL[chronicleItem](file)
		if err != nil {
			return err
		}
		base := maxSeq(existing)
		now := nowMS()
		full = entry
		full.Seq = base + 1
		full.TS = now

		data, err := json.Marshal(full)
		if err != nil {
			return fmt.Errorf("marshal chronicle: %w", err)
		}

		f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			return fmt.Errorf("open chronicle: %w", err)
		}
		defer f.Close()
		if _, err := f.Write(data); err != nil {
			return err
		}
		_, err = f.Write([]byte("\n"))
		return err
	})

	return full, err
}

func (s *JSONLChronicleStore) Recent(query ChronicleQuery) ([]ChronicleEntry, error) {
	limit := query.Limit
	if limit <= 0 {
		limit = 50
	}

	items, err := readJSONL[chronicleEntry](s.file())
	if err != nil {
		return nil, err
	}
	legacy, err := readJSONL[chronicleEntry](s.legacyFile())
	if err != nil {
		return nil, err
	}
	items = append(items, legacy...)

	// Filter
	var filtered []ChronicleEntry
	for _, e := range items {
		if query.TaskID != "" && e.TaskID != query.TaskID {
			continue
		}
		if query.Type != "" && e.Type != query.Type {
			continue
		}
		filtered = append(filtered, e.ChronicleEntry)
	}

	sort.Slice(filtered, func(i, j int) bool {
		if filtered[i].TS != filtered[j].TS {
			return filtered[i].TS > filtered[j].TS
		}
		return filtered[i].Seq > filtered[j].Seq
	})

	if len(filtered) > limit {
		filtered = filtered[:limit]
	}
	return filtered, nil
}

// JSONProjectionStore implements ProjectionStore using per-task JSON files.
type JSONProjectionStore struct {
	dir string
	mu  sync.Mutex
}

func NewJSONProjectionStore(dir string) *JSONProjectionStore {
	return &JSONProjectionStore{dir: dir}
}

func (s *JSONProjectionStore) projectionFile(taskID string) string {
	return filepath.Join(s.dir, "projections", sanitize(taskID)+".json")
}

func (s *JSONProjectionStore) projectionFileInState(stateDir, taskID string) string {
	return filepath.Join(stateDir, "projections", sanitize(taskID)+".json")
}

func (s *JSONProjectionStore) Get(taskID string) (*workflow.Task, error) {
	dirs, err := listProjectStateDirs(s.dir)
	if err != nil {
		return nil, err
	}
	for _, dir := range dirs {
		data, err := os.ReadFile(s.projectionFileInState(dir, taskID))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		var task workflow.Task
		if err := json.Unmarshal(data, &task); err != nil {
			return nil, fmt.Errorf("unmarshal projection %s: %w", taskID, err)
		}
		return &task, nil
	}

	data, err := os.ReadFile(s.projectionFile(taskID))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var task workflow.Task
	if err := json.Unmarshal(data, &task); err != nil {
		return nil, fmt.Errorf("unmarshal projection %s: %w", taskID, err)
	}
	return &task, nil
}

func (s *JSONProjectionStore) Put(task workflow.Task) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	projectID := task.ProjectID
	if projectID == "" {
		projectID = "default"
	}
	file := s.projectionFileInState(projectStateDir(s.dir, projectID), task.ID)
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		return fmt.Errorf("mkdir projections: %w", err)
	}

	return withFileLock(file, func() error {
		tmp := file + fmt.Sprintf(".%d.tmp", os.Getpid())
		data, err := json.Marshal(task)
		if err != nil {
			return fmt.Errorf("marshal projection: %w", err)
		}
		if err := os.WriteFile(tmp, data, 0644); err != nil {
			return fmt.Errorf("write tmp: %w", err)
		}
		return os.Rename(tmp, file)
	})
}

func (s *JSONProjectionStore) Query(filter TaskQuery) ([]workflow.Task, error) {
	roots, err := listProjectStateDirs(s.dir)
	if err != nil {
		return nil, err
	}
	roots = append(roots, s.dir)

	byID := make(map[string]workflow.Task)
	for _, root := range roots {
		entries, err := os.ReadDir(filepath.Join(root, "projections"))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(root, "projections", entry.Name()))
			if err != nil {
				continue // skip unreadable files
			}
			var task workflow.Task
			if err := json.Unmarshal(data, &task); err != nil {
				continue // skip corrupt files
			}
			if filter.ProjectID != "" && task.ProjectID != filter.ProjectID {
				continue
			}
			if filter.WorkflowID != "" && task.WorkflowID != filter.WorkflowID {
				continue
			}
			if filter.Status != "" && task.Status != filter.Status {
				continue
			}
			if _, exists := byID[task.ID]; !exists {
				byID[task.ID] = task
			}
		}
	}

	var results []workflow.Task
	for _, task := range byID {
		results = append(results, task)
	}
	return results, nil
}

// ── Chronicle entry wrapper for JSON deserialization ───────────────────────

type chronicleEntry struct {
	ChronicleEntry
}

func (c chronicleEntry) GetSeq() int { return c.Seq }

func nowMS() int64 {
	return time.Now().UnixMilli()
}
