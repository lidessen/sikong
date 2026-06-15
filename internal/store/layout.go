package store

import (
	"os"
	"path/filepath"
)

func projectDir(root, projectID string) string {
	return filepath.Join(root, "projects", sanitize(projectID))
}

func projectStateDir(root, projectID string) string {
	return filepath.Join(projectDir(root, projectID), "state")
}

func workspaceStateDir(root string) string {
	return filepath.Join(root, "state")
}

func listProjectStateDirs(root string) ([]string, error) {
	dirs := []string{projectStateDir(root, "default")}
	seen := map[string]bool{dirs[0]: true}

	entries, err := os.ReadDir(filepath.Join(root, "projects"))
	if err != nil {
		if os.IsNotExist(err) {
			return dirs, nil
		}
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, "projects", entry.Name(), "state")
		if !seen[dir] {
			seen[dir] = true
			dirs = append(dirs, dir)
		}
	}
	return dirs, nil
}
