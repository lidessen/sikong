package runtimebundle

import (
	"embed"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

//go:embed assets
var assets embed.FS

type Paths struct {
	Root                string
	Daemon              string
	WorkspaceCLI        string
	ClientAPI           string
	OrchestrationRunner string
	ProcessRunner       string
	ClientDist          string
}

func Extract(version string) (Paths, bool, error) {
	if strings.TrimSpace(version) == "" {
		version = "dev"
	}
	files, err := bundledFiles()
	if err != nil {
		return Paths{}, false, err
	}
	if len(files) == 0 {
		return Paths{}, false, nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, false, err
	}
	root := filepath.Join(home, ".sikong", "runtime", sanitizeVersion(version))
	for _, file := range files {
		target := filepath.Join(root, file.rel)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return Paths{}, false, err
		}
		data, err := assets.ReadFile(file.path)
		if err != nil {
			return Paths{}, false, err
		}
		mode := os.FileMode(0o644)
		if strings.HasPrefix(file.rel, "bin/") {
			mode = 0o755
		}
		if err := os.WriteFile(target, data, mode); err != nil {
			return Paths{}, false, err
		}
	}

	return Paths{
		Root:                root,
		Daemon:              filepath.Join(root, "bin", "sikongd"),
		WorkspaceCLI:        filepath.Join(root, "bin", "sikong-workspace-cli"),
		ClientAPI:           filepath.Join(root, "bin", "sikong-client-api"),
		OrchestrationRunner: filepath.Join(root, "bin", "sikong-orchestration-runner"),
		ProcessRunner:       filepath.Join(root, "bin", "sikong-process-runner"),
		ClientDist:          filepath.Join(root, "client-dist"),
	}, true, nil
}

type bundledFile struct {
	path string
	rel  string
}

func bundledFiles() ([]bundledFile, error) {
	files := []bundledFile{}
	err := fs.WalkDir(assets, "assets", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel := strings.TrimPrefix(path, "assets/")
		if rel == "" || rel == "README.txt" {
			return nil
		}
		files = append(files, bundledFile{path: path, rel: rel})
		return nil
	})
	return files, err
}

func sanitizeVersion(version string) string {
	replacer := strings.NewReplacer("/", "-", "\\", "-", ":", "-", " ", "-")
	return replacer.Replace(version)
}
