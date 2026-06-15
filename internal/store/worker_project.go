package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

// JSONWorkerStore implements WorkerStore using per-worker YAML files.
type JSONWorkerStore struct {
	dir string
	mu  sync.RWMutex
}

func NewJSONWorkerStore(dir string) *JSONWorkerStore {
	return &JSONWorkerStore{dir: dir}
}

func (s *JSONWorkerStore) workerFile(id string) string {
	return filepath.Join(s.dir, "workers", sanitize(id)+".yaml")
}

func (s *JSONWorkerStore) Get(id string) (*Worker, error) {
	data, err := os.ReadFile(s.workerFile(id))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var w Worker
	if err := yaml.Unmarshal(data, &w); err != nil {
		return nil, fmt.Errorf("unmarshal worker %s: %w", id, err)
	}
	return &w, nil
}

func (s *JSONWorkerStore) Put(worker Worker) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	file := s.workerFile(worker.ID)
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		return fmt.Errorf("mkdir workers: %w", err)
	}
	data, err := yaml.Marshal(worker)
	if err != nil {
		return fmt.Errorf("marshal worker: %w", err)
	}
	return os.WriteFile(file, data, 0644)
}

func (s *JSONWorkerStore) List() ([]Worker, error) {
	dir := filepath.Join(s.dir, "workers")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var workers []Worker
	for _, entry := range entries {
		if entry.IsDir() || !isYAMLFile(entry.Name()) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var w Worker
		if err := yaml.Unmarshal(data, &w); err != nil {
			continue
		}
		workers = append(workers, w)
	}
	return workers, nil
}

// JSONProjectStore implements ProjectStore using per-project YAML files.
type JSONProjectStore struct {
	dir string
	mu  sync.RWMutex
}

func NewJSONProjectStore(dir string) *JSONProjectStore {
	return &JSONProjectStore{dir: dir}
}

func (s *JSONProjectStore) projectFile(id string) string {
	return filepath.Join(s.dir, "projects", id, "project.yaml")
}

func (s *JSONProjectStore) Get(id string) (*Project, error) {
	data, err := os.ReadFile(s.projectFile(id))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var p Project
	if err := yaml.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("unmarshal project %s: %w", id, err)
	}
	return &p, nil
}

func (s *JSONProjectStore) Put(project Project) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	file := s.projectFile(project.ID)
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		return fmt.Errorf("mkdir project: %w", err)
	}
	data, err := yaml.Marshal(project)
	if err != nil {
		return fmt.Errorf("marshal project: %w", err)
	}
	return os.WriteFile(file, data, 0644)
}

func (s *JSONProjectStore) List() ([]Project, error) {
	dir := filepath.Join(s.dir, "projects")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var projects []Project
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		p, err := s.Get(entry.Name())
		if err != nil || p == nil {
			continue
		}
		projects = append(projects, *p)
	}
	return projects, nil
}

// MemoryPath returns the path to a project's memory file.
func (s *JSONProjectStore) MemoryPath(projectID string) string {
	return filepath.Join(s.dir, "projects", projectID, "memory.md")
}

// GetMemory reads the project memory file, returns empty string if absent.
func (s *JSONProjectStore) GetMemory(projectID string) (string, error) {
	data, err := os.ReadFile(s.MemoryPath(projectID))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(data), nil
}

// PutMemory writes markdown to the project's memory file.
func (s *JSONProjectStore) PutMemory(projectID, markdown string) error {
	path := s.MemoryPath(projectID)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	return os.WriteFile(path, []byte(markdown), 0644)
}

func isYAMLFile(name string) bool {
	return strings.HasSuffix(name, ".yaml") || strings.HasSuffix(name, ".yml")
}
