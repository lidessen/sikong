package store

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/esengine/sikong/internal/workflow"
)

type JSONWorkflowRegistry struct {
	dir string
}

func NewJSONWorkflowRegistry(dir string) *JSONWorkflowRegistry {
	return &JSONWorkflowRegistry{dir: dir}
}

func (r *JSONWorkflowRegistry) Register(def workflow.WorkflowDef) error {
	if def.ID == "" {
		return fmt.Errorf("workflow id is required")
	}
	if def.Version == "" {
		def.Version = "1"
	}
	data, err := yaml.Marshal(def)
	if err != nil {
		return fmt.Errorf("marshal workflow: %w", err)
	}
	return SaveWorkflow(r.dir, def.ID, def.Version, data)
}

func (r *JSONWorkflowRegistry) Get(id string, version string) (*workflow.WorkflowDef, error) {
	if id == "" {
		id = "general"
	}
	if version == "" {
		version = "1"
	}

	data, err := ReadWorkflow(r.dir, id, version)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		if id == "general" && version == "1" {
			wf := workflow.GeneralWorkflow()
			return &wf, nil
		}
		return nil, nil
	}

	var wf workflow.WorkflowDef
	if err := yaml.Unmarshal(data, &wf); err != nil {
		return nil, fmt.Errorf("parse workflow %s@%s: %w", id, version, err)
	}
	if wf.Version == "" {
		wf.Version = version
	}
	return &wf, nil
}

func (r *JSONWorkflowRegistry) List() ([]workflow.WorkflowDef, error) {
	byKey := map[string]workflow.WorkflowDef{}
	general := workflow.GeneralWorkflow()
	byKey[general.ID+"@"+general.Version] = general

	entries, err := os.ReadDir(filepath.Join(r.dir, "workflows"))
	if err != nil {
		if os.IsNotExist(err) {
			return mapValuesSorted(byKey), nil
		}
		return nil, err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".yaml") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(r.dir, "workflows", entry.Name()))
		if err != nil {
			return nil, err
		}
		var wf workflow.WorkflowDef
		if err := yaml.Unmarshal(data, &wf); err != nil {
			return nil, fmt.Errorf("parse workflow %s: %w", entry.Name(), err)
		}
		if wf.ID == "" {
			continue
		}
		if wf.Version == "" {
			wf.Version = "1"
		}
		byKey[wf.ID+"@"+wf.Version] = wf
	}
	return mapValuesSorted(byKey), nil
}

func mapValuesSorted(items map[string]workflow.WorkflowDef) []workflow.WorkflowDef {
	keys := make([]string, 0, len(items))
	for key := range items {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]workflow.WorkflowDef, 0, len(keys))
	for _, key := range keys {
		out = append(out, items[key])
	}
	return out
}
