package daemon

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type processJournal struct {
	dir string
}

func newProcessJournal(dataDir string) (*processJournal, error) {
	dir := filepath.Join(dataDir, "daemon", "process-runs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &processJournal{dir: dir}, nil
}

func (j *processJournal) path(runID string) string {
	return filepath.Join(j.dir, safeRunID(runID)+".json")
}

func (j *processJournal) save(snapshot ProcessRunSnapshot) error {
	if j == nil {
		return nil
	}
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	tmp := j.path(snapshot.RunID) + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, j.path(snapshot.RunID))
}

func (j *processJournal) load(runID string) (ProcessRunSnapshot, bool, error) {
	if j == nil {
		return ProcessRunSnapshot{}, false, nil
	}
	data, err := os.ReadFile(j.path(runID))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ProcessRunSnapshot{}, false, nil
		}
		return ProcessRunSnapshot{}, false, err
	}
	var snapshot ProcessRunSnapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return ProcessRunSnapshot{}, false, err
	}
	return snapshot, true, nil
}

func (j *processJournal) loadAll() ([]ProcessRunSnapshot, error) {
	if j == nil {
		return nil, nil
	}
	entries, err := os.ReadDir(j.dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	snapshots := make([]ProcessRunSnapshot, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(j.dir, entry.Name()))
		if err != nil {
			continue
		}
		var snapshot ProcessRunSnapshot
		if err := json.Unmarshal(data, &snapshot); err != nil {
			continue
		}
		snapshots = append(snapshots, snapshot)
	}
	return snapshots, nil
}

func safeRunID(runID string) string {
	return strings.NewReplacer("/", "_", "\\", "_", "..", "_").Replace(runID)
}

func reconcileJournalSnapshot(snapshot ProcessRunSnapshot) ProcessRunSnapshot {
	if snapshot.State != ProcessRunQueued && snapshot.State != ProcessRunRunning {
		return snapshot
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	message := "process run interrupted by daemon restart"
	result := ProcessRunResult{
		RunID:       snapshot.RunID,
		WorkspaceID: snapshot.WorkspaceID,
		TaskID:      snapshot.TaskID,
		Status:      ProcessRunFailed,
		Command:     snapshot.Spec.Command,
		Args:        append([]string(nil), snapshot.Spec.Args...),
		Cwd:         snapshot.Spec.Cwd,
		Labels:      cloneStringMap(snapshot.Spec.Labels),
		Stdout:      "",
		Stderr:      message,
		StartedAt:   firstNonEmpty(snapshot.StartedAt, snapshot.QueuedAt, now),
		FinishedAt:  now,
		DurationMS:  0,
	}
	snapshot.State = ProcessRunFinished
	snapshot.Result = &result
	snapshot.Error = message
	snapshot.FinishedAt = now
	return snapshot
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return time.Now().UTC().Format(time.RFC3339Nano)
}
