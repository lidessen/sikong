package store

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// WorkspaceConfig is the serialized workspace-level configuration.
type WorkspaceConfig struct {
	DefaultWorkerID string `yaml:"defaultWorkerId,omitempty"`
}

// configPath returns the workspace config file path.
func configPath(dir string) string {
	return filepath.Join(dir, "config.yaml")
}

// GetDefaultWorker reads the default worker id from workspace config.
func GetDefaultWorker(dir string) (string, error) {
	data, err := os.ReadFile(configPath(dir))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	var cfg WorkspaceConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return "", fmt.Errorf("parse config: %w", err)
	}
	return cfg.DefaultWorkerID, nil
}

// SetDefaultWorker writes the default worker id to workspace config.
// Preserves any existing config fields.
func SetDefaultWorker(dir, workerID string) error {
	path := configPath(dir)
	var cfg WorkspaceConfig

	if data, err := os.ReadFile(path); err == nil {
		yaml.Unmarshal(data, &cfg)
	} else if !os.IsNotExist(err) {
		return err
	}

	cfg.DefaultWorkerID = workerID
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	return os.WriteFile(path, data, 0644)
}

// SaveWorkflow writes a workflow definition YAML to the workspace.
func SaveWorkflow(dir string, id, version string, data []byte) error {
	filename := fmt.Sprintf("%s@%s.yaml", id, version)
	path := filepath.Join(dir, "workflows", filename)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("mkdir workflows: %w", err)
	}
	return os.WriteFile(path, data, 0644)
}

// WorkflowDefPath returns the path for a workflow definition file.
func WorkflowDefPath(dir, id, version string) string {
	return filepath.Join(dir, "workflows", fmt.Sprintf("%s@%s.yaml", id, version))
}

// ReadWorkflow reads a workflow definition from the workspace.
func ReadWorkflow(dir, id, version string) ([]byte, error) {
	return os.ReadFile(WorkflowDefPath(dir, id, version))
}
