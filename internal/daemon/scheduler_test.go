package daemon

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSchedulerScansRunnableTasksAndTicks(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	dataDir := filepath.Join(dir, "data")
	script := filepath.Join(dir, "workspace-cli.sh")
	body := `#!/bin/sh
if [ "$1" = "task" ] && [ "$2" = "runnable" ]; then
  echo '{"ok":true,"data":{"tasks":[{"workspaceId":"workspace_a","taskId":"task_a"}]}}'
  exit 0
fi
if [ "$1" = "task" ] && [ "$2" = "tick" ]; then
  echo "$@ data=$SIKONG_DATA_DIR daemon=$SIKONG_DAEMON_ADDR" >> "` + logPath + `"
  echo '{"ok":true,"data":{}}'
  exit 0
fi
echo "unexpected command: $@" >&2
exit 1
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatalf("write fake cli: %v", err)
	}

	scheduler := NewScheduler(context.Background(), SchedulerOptions{
		Addr:          "127.0.0.1:9876",
		DataDir:       dataDir,
		Command:       script,
		MaxConcurrent: 1,
	})
	scheduler.scanAndStart()

	var logText string
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(logPath)
		if err == nil {
			logText = string(data)
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if logText == "" {
		t.Fatal("scheduler did not invoke task tick")
	}
	for _, want := range []string{
		"task tick task_a --workspace workspace_a --daemon 127.0.0.1:9876",
		"--process-timeout-ms 7200000 --wait-timeout-ms 7260000",
		"data=" + dataDir,
		"daemon=127.0.0.1:9876",
	} {
		if !strings.Contains(logText, want) {
			t.Fatalf("tick log = %q, want %q", logText, want)
		}
	}
	status := scheduler.Status()
	if status.Started != 1 || status.Completed != 1 || status.RunnableSeen != 1 {
		t.Fatalf("status = %+v, want one started/completed/runnable task", status)
	}
	if status.ProcessTimeoutMS != defaultSchedulerProcessTimeoutMS || status.WaitTimeoutMS != defaultSchedulerWaitTimeoutMS {
		t.Fatalf("status timeouts = %d/%d, want defaults", status.ProcessTimeoutMS, status.WaitTimeoutMS)
	}
}

func TestSchedulerTimeoutEnvOverrides(t *testing.T) {
	t.Setenv(schedulerProcessTimeoutMSEnv, "12345")
	t.Setenv(schedulerWaitTimeoutMSEnv, "23456")

	scheduler := NewScheduler(context.Background(), SchedulerOptions{
		MaxConcurrent: 1,
	})
	status := scheduler.Status()
	if status.ProcessTimeoutMS != 12345 || status.WaitTimeoutMS != 23456 {
		t.Fatalf("status timeouts = %d/%d, want env overrides", status.ProcessTimeoutMS, status.WaitTimeoutMS)
	}
}

func TestSchedulerClearsStaleErrorAfterSuccessfulTick(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	script := filepath.Join(dir, "workspace-cli.sh")
	body := `#!/bin/sh
if [ "$1" = "task" ] && [ "$2" = "runnable" ]; then
  echo '{"ok":true,"data":{"tasks":[{"workspaceId":"workspace_a","taskId":"task_a"}]}}'
  exit 0
fi
if [ "$1" = "task" ] && [ "$2" = "tick" ]; then
  echo "$@" >> "` + logPath + `"
  echo '{"ok":true,"data":{}}'
  exit 0
fi
exit 1
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatalf("write fake cli: %v", err)
	}

	scheduler := NewScheduler(context.Background(), SchedulerOptions{
		Addr:          "127.0.0.1:9876",
		Command:       script,
		MaxConcurrent: 1,
	})
	scheduler.setError(errors.New("stale error"))
	scheduler.scanAndStart()

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if scheduler.Status().Completed == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	status := scheduler.Status()
	if status.Completed != 1 {
		t.Fatalf("status = %+v, want completed tick", status)
	}
	if status.LastError != "" {
		t.Fatalf("lastError = %q, want cleared", status.LastError)
	}
}
