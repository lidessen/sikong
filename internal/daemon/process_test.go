package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProcessRunnerSuccess(t *testing.T) {
	t.Parallel()
	runner := NewProcessRunner(ProcessRunnerOptions{MaxConcurrent: 2})

	result, err := runner.Run(context.Background(), ProcessRunSpec{
		RunID:       "run-success",
		WorkspaceID: "workspace",
		Command:     "sh",
		Args:        []string{"-c", "printf '%s' \"$SIKONG_TEST_VALUE:$PWD\""},
		Cwd:         t.TempDir(),
		Env:         map[string]string{"SIKONG_TEST_VALUE": "ok"},
		Labels:      map[string]string{"debug": "true"},
	})

	if err != nil {
		t.Fatalf("Run returned error: %v", err)
	}
	if result.Status != ProcessRunSucceeded {
		t.Fatalf("status = %q, want %q", result.Status, ProcessRunSucceeded)
	}
	if !strings.HasPrefix(result.Stdout, "ok:") {
		t.Fatalf("stdout = %q, want env and cwd output", result.Stdout)
	}
	if result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("exitCode = %v, want 0", result.ExitCode)
	}
	if result.DurationMS < 0 {
		t.Fatalf("durationMs = %d, want non-negative", result.DurationMS)
	}
	if result.Labels["debug"] != "true" {
		t.Fatalf("labels were not preserved: %#v", result.Labels)
	}
}

func TestProcessRunnerFailure(t *testing.T) {
	t.Parallel()
	runner := NewProcessRunner(ProcessRunnerOptions{})

	result, err := runner.Run(context.Background(), ProcessRunSpec{
		RunID:       "run-failure",
		WorkspaceID: "workspace",
		Command:     "sh",
		Args:        []string{"-c", "echo bad >&2; exit 7"},
	})

	if err != nil {
		t.Fatalf("Run returned unexpected error for process exit: %v", err)
	}
	if result.Status != ProcessRunFailed {
		t.Fatalf("status = %q, want %q", result.Status, ProcessRunFailed)
	}
	if result.ExitCode == nil || *result.ExitCode != 7 {
		t.Fatalf("exitCode = %v, want 7", result.ExitCode)
	}
	if strings.TrimSpace(result.Stderr) != "bad" {
		t.Fatalf("stderr = %q, want bad", result.Stderr)
	}
}

func TestProcessRunnerTimeout(t *testing.T) {
	t.Parallel()
	runner := NewProcessRunner(ProcessRunnerOptions{})

	result, err := runner.Run(context.Background(), ProcessRunSpec{
		RunID:       "run-timeout",
		WorkspaceID: "workspace",
		Command:     "sh",
		Args:        []string{"-c", "sleep 1"},
		TimeoutMS:   50,
	})

	if err != nil {
		t.Fatalf("Run returned unexpected error for timeout: %v", err)
	}
	if result.Status != ProcessRunTimedOut {
		t.Fatalf("status = %q, want %q", result.Status, ProcessRunTimedOut)
	}
	if !result.TimedOut {
		t.Fatalf("timedOut = false, want true")
	}
}

func TestProcessRunnerCancel(t *testing.T) {
	t.Parallel()
	runner := NewProcessRunner(ProcessRunnerOptions{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan ProcessRunResult, 1)
	errs := make(chan error, 1)

	go func() {
		result, err := runner.Run(ctx, ProcessRunSpec{
			RunID:       "run-cancel",
			WorkspaceID: "workspace",
			Command:     "sh",
			Args:        []string{"-c", "sleep 1"},
		})
		done <- result
		errs <- err
	}()

	time.Sleep(30 * time.Millisecond)
	cancel()

	select {
	case result := <-done:
		if err := <-errs; err != nil {
			t.Fatalf("Run returned unexpected error for cancel: %v", err)
		}
		if result.Status != ProcessRunCancelled {
			t.Fatalf("status = %q, want %q", result.Status, ProcessRunCancelled)
		}
		if !result.Cancelled {
			t.Fatalf("cancelled = false, want true")
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("cancelled process did not return")
	}
}

func TestProcessRunnerParallelRuns(t *testing.T) {
	t.Parallel()
	runner := NewProcessRunner(ProcessRunnerOptions{MaxConcurrent: 4})
	start := time.Now()

	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			result, err := runner.Run(context.Background(), ProcessRunSpec{
				RunID:       "run-parallel",
				WorkspaceID: "workspace",
				Command:     "sh",
				Args:        []string{"-c", "sleep 0.2; echo done"},
			})
			if err != nil {
				errs <- err
				return
			}
			if result.Status != ProcessRunSucceeded {
				errs <- context.Canceled
				return
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("parallel run failed: %v", err)
		}
	}
	if elapsed := time.Since(start); elapsed > 700*time.Millisecond {
		t.Fatalf("parallel runs took %s, expected concurrent execution", elapsed)
	}
}

func TestProcessRunSpecHasNoAgentRoleFields(t *testing.T) {
	t.Parallel()
	raw, err := json.Marshal(ProcessRunSpec{
		RunID:       "run",
		WorkspaceID: "workspace",
		Command:     "echo",
		Args:        []string{"ok"},
	})
	if err != nil {
		t.Fatalf("marshal spec: %v", err)
	}
	text := string(raw)
	for _, forbidden := range []string{"role", "kind", "planner", "reviewer"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("ProcessRunSpec JSON contains forbidden agent semantic %q: %s", forbidden, text)
		}
	}
}

func TestProcessSupervisorStoresResults(t *testing.T) {
	t.Parallel()
	supervisor := NewProcessSupervisor(ProcessRunnerOptions{})
	result, err := supervisor.Run(context.Background(), ProcessRunSpec{
		RunID:       "run-stored",
		WorkspaceID: "workspace",
		Command:     "sh",
		Args:        []string{"-c", "echo stored"},
	})
	if err != nil {
		t.Fatalf("Run returned error: %v", err)
	}
	stored, ok := supervisor.Get("run-stored")
	if !ok {
		t.Fatal("stored result not found")
	}
	if stored.RunID != result.RunID || strings.TrimSpace(stored.Stdout) != "stored" {
		t.Fatalf("stored result = %#v, want %#v", stored, result)
	}
}

func TestProcessSupervisorStartWaitCancel(t *testing.T) {
	t.Parallel()
	supervisor := NewProcessSupervisor(ProcessRunnerOptions{})

	started, err := supervisor.Start(context.Background(), ProcessRunSpec{
		RunID:       "run-async",
		WorkspaceID: "workspace",
		Command:     "sh",
		Args:        []string{"-c", "sleep 0.05; echo async"},
	})
	if err != nil {
		t.Fatalf("Start returned error: %v", err)
	}
	if started.State != ProcessRunQueued {
		t.Fatalf("started state = %q, want %q", started.State, ProcessRunQueued)
	}
	if started.QueuedAt == "" {
		t.Fatalf("queuedAt was empty for queued snapshot")
	}
	if started.StartedAt != "" {
		t.Fatalf("startedAt = %q, want empty before the process actually starts", started.StartedAt)
	}

	eventuallyRunning := false
	for i := 0; i < 20; i++ {
		snapshot, ok := supervisor.GetSnapshot("run-async")
		if !ok {
			t.Fatal("started run disappeared")
		}
		if snapshot.State == ProcessRunRunning || snapshot.State == ProcessRunFinished {
			eventuallyRunning = true
			if snapshot.StartedAt == "" {
				t.Fatalf("startedAt was empty once state reached %q", snapshot.State)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !eventuallyRunning {
		t.Fatalf("run did not leave queued state")
	}

	finished, ok, err := supervisor.Wait(context.Background(), "run-async")
	if err != nil {
		t.Fatalf("Wait returned error: %v", err)
	}
	if !ok {
		t.Fatal("Wait did not find run")
	}
	if finished.State != ProcessRunFinished || finished.Result == nil {
		t.Fatalf("finished snapshot = %#v, want finished result", finished)
	}
	if strings.TrimSpace(finished.Result.Stdout) != "async" {
		t.Fatalf("stdout = %q, want async", finished.Result.Stdout)
	}

	_, err = supervisor.Start(context.Background(), ProcessRunSpec{
		RunID:       "run-cancel-async",
		WorkspaceID: "workspace",
		Command:     "sh",
		Args:        []string{"-c", "sleep 1"},
	})
	if err != nil {
		t.Fatalf("Start cancel run returned error: %v", err)
	}
	if _, ok := supervisor.Cancel("run-cancel-async"); !ok {
		t.Fatal("Cancel did not find run")
	}
	cancelled, ok, err := supervisor.Wait(context.Background(), "run-cancel-async")
	if err != nil {
		t.Fatalf("Wait cancelled returned error: %v", err)
	}
	if !ok || cancelled.Result == nil {
		t.Fatalf("cancelled snapshot = %#v, want result", cancelled)
	}
	if cancelled.Result.Status != ProcessRunCancelled {
		t.Fatalf("status = %q, want %q", cancelled.Result.Status, ProcessRunCancelled)
	}
}

func TestProcessSupervisorReportsQueuedBeforeActualStart(t *testing.T) {
	t.Parallel()
	supervisor := NewProcessSupervisor(ProcessRunnerOptions{MaxConcurrent: 1})

	first, err := supervisor.Start(context.Background(), ProcessRunSpec{
		RunID:       "run-blocking",
		WorkspaceID: "workspace",
		Command:     "sh",
		Args:        []string{"-c", "sleep 0.2"},
	})
	if err != nil {
		t.Fatalf("Start first returned error: %v", err)
	}
	if first.State != ProcessRunQueued {
		t.Fatalf("first state = %q, want queued", first.State)
	}

	for i := 0; i < 20; i++ {
		snapshot, ok := supervisor.GetSnapshot("run-blocking")
		if !ok {
			t.Fatal("first run disappeared")
		}
		if snapshot.State == ProcessRunRunning {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	second, err := supervisor.Start(context.Background(), ProcessRunSpec{
		RunID:       "run-waiting",
		WorkspaceID: "workspace",
		Command:     "sh",
		Args:        []string{"-c", "echo waiting"},
	})
	if err != nil {
		t.Fatalf("Start second returned error: %v", err)
	}
	if second.State != ProcessRunQueued {
		t.Fatalf("second state = %q, want queued while the concurrency slot is occupied", second.State)
	}
	if second.StartedAt != "" {
		t.Fatalf("second startedAt = %q, want empty while queued", second.StartedAt)
	}

	queued := supervisor.ListSnapshots(ProcessRunListFilter{State: ProcessRunQueued})
	foundQueued := false
	for _, snapshot := range queued {
		if snapshot.RunID == "run-waiting" {
			foundQueued = true
			break
		}
	}
	if !foundQueued {
		t.Fatalf("queued snapshots did not include run-waiting: %#v", queued)
	}
}

func TestProcessAPIRunLifecycle(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(NewProcessAPI(context.Background(), NewProcessSupervisor(ProcessRunnerOptions{})))
	defer server.Close()

	body, err := json.Marshal(ProcessRunSpec{
		RunID:       "run-api",
		WorkspaceID: "workspace",
		TaskID:      "task-api",
		Command:     "sh",
		Args:        []string{"-c", "echo api"},
	})
	if err != nil {
		t.Fatalf("marshal spec: %v", err)
	}
	resp, err := http.Post(server.URL+"/process-runs", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST process-runs: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("POST status = %d, want %d", resp.StatusCode, http.StatusAccepted)
	}

	waitResp, err := http.Get(server.URL + "/process-runs/run-api/wait?timeoutMs=1000")
	if err != nil {
		t.Fatalf("GET wait: %v", err)
	}
	defer waitResp.Body.Close()
	if waitResp.StatusCode != http.StatusOK {
		t.Fatalf("wait status = %d, want %d", waitResp.StatusCode, http.StatusOK)
	}
	var snapshot ProcessRunSnapshot
	if err := json.NewDecoder(waitResp.Body).Decode(&snapshot); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if snapshot.State != ProcessRunFinished || snapshot.Result == nil {
		t.Fatalf("snapshot = %#v, want finished result", snapshot)
	}
	if strings.TrimSpace(snapshot.Result.Stdout) != "api" {
		t.Fatalf("stdout = %q, want api", snapshot.Result.Stdout)
	}

	listResp, err := http.Get(server.URL + "/process-runs?workspaceId=workspace&taskId=task-api&state=finished&limit=1")
	if err != nil {
		t.Fatalf("GET process-runs: %v", err)
	}
	defer listResp.Body.Close()
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d, want %d", listResp.StatusCode, http.StatusOK)
	}
	var listed struct {
		Runs []ProcessRunSnapshot `json:"runs"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&listed); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(listed.Runs) != 1 || listed.Runs[0].RunID != "run-api" {
		t.Fatalf("listed runs = %#v, want run-api", listed.Runs)
	}

	badResp, err := http.Get(server.URL + "/process-runs?state=unknown")
	if err != nil {
		t.Fatalf("GET bad process-runs: %v", err)
	}
	defer badResp.Body.Close()
	if badResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad list status = %d, want %d", badResp.StatusCode, http.StatusBadRequest)
	}
}

func TestProcessAPICancel(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(NewProcessAPI(context.Background(), NewProcessSupervisor(ProcessRunnerOptions{})))
	defer server.Close()

	body, err := json.Marshal(ProcessRunSpec{
		RunID:       "run-api-cancel",
		WorkspaceID: "workspace",
		Command:     "sh",
		Args:        []string{"-c", "sleep 1"},
	})
	if err != nil {
		t.Fatalf("marshal spec: %v", err)
	}
	resp, err := http.Post(server.URL+"/process-runs", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST process-runs: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("POST status = %d, want %d", resp.StatusCode, http.StatusAccepted)
	}

	cancelResp, err := http.Post(server.URL+"/process-runs/run-api-cancel/cancel", "application/json", nil)
	if err != nil {
		t.Fatalf("POST cancel: %v", err)
	}
	cancelResp.Body.Close()
	if cancelResp.StatusCode != http.StatusOK {
		t.Fatalf("cancel status = %d, want %d", cancelResp.StatusCode, http.StatusOK)
	}

	waitResp, err := http.Get(server.URL + "/process-runs/run-api-cancel/wait?timeoutMs=1000")
	if err != nil {
		t.Fatalf("GET wait: %v", err)
	}
	defer waitResp.Body.Close()
	var snapshot ProcessRunSnapshot
	if err := json.NewDecoder(waitResp.Body).Decode(&snapshot); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if snapshot.Result == nil || snapshot.Result.Status != ProcessRunCancelled {
		t.Fatalf("snapshot = %#v, want cancelled result", snapshot)
	}
}
