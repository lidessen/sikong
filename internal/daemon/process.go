package daemon

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

type ProcessRunSpec struct {
	RunID       string            `json:"runId"`
	WorkspaceID string            `json:"workspaceId"`
	TaskID      string            `json:"taskId,omitempty"`
	Command     string            `json:"command"`
	Args        []string          `json:"args,omitempty"`
	Cwd         string            `json:"cwd,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	TimeoutMS   int64             `json:"timeoutMs,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Stdin       string            `json:"stdin,omitempty"`
}

type ProcessRunStatus string

const (
	ProcessRunSucceeded ProcessRunStatus = "succeeded"
	ProcessRunFailed    ProcessRunStatus = "failed"
	ProcessRunTimedOut  ProcessRunStatus = "timed_out"
	ProcessRunCancelled ProcessRunStatus = "cancelled"
)

type ProcessRunState string

const (
	ProcessRunQueued   ProcessRunState = "queued"
	ProcessRunRunning  ProcessRunState = "running"
	ProcessRunFinished ProcessRunState = "finished"
)

type ProcessRunResult struct {
	RunID       string            `json:"runId"`
	WorkspaceID string            `json:"workspaceId"`
	TaskID      string            `json:"taskId,omitempty"`
	Status      ProcessRunStatus  `json:"status"`
	Command     string            `json:"command"`
	Args        []string          `json:"args"`
	Cwd         string            `json:"cwd,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	ExitCode    *int              `json:"exitCode,omitempty"`
	Signal      string            `json:"signal,omitempty"`
	Stdout      string            `json:"stdout"`
	Stderr      string            `json:"stderr"`
	StdoutTruncated bool          `json:"stdoutTruncated,omitempty"`
	StderrTruncated bool          `json:"stderrTruncated,omitempty"`
	StartedAt   string            `json:"startedAt"`
	FinishedAt  string            `json:"finishedAt"`
	DurationMS  int64             `json:"durationMs"`
	TimedOut    bool              `json:"timedOut,omitempty"`
	Cancelled   bool              `json:"cancelled,omitempty"`
}

type ProcessRunSnapshot struct {
	RunID       string            `json:"runId"`
	WorkspaceID string            `json:"workspaceId"`
	TaskID      string            `json:"taskId,omitempty"`
	State       ProcessRunState   `json:"state"`
	Spec        ProcessRunSpec    `json:"spec"`
	Result      *ProcessRunResult `json:"result,omitempty"`
	Error       string            `json:"error,omitempty"`
	QueuedAt    string            `json:"queuedAt,omitempty"`
	StartedAt   string            `json:"startedAt,omitempty"`
	FinishedAt  string            `json:"finishedAt,omitempty"`
}

type ProcessRunListFilter struct {
	WorkspaceID string
	TaskID      string
	State       ProcessRunState
}

type ProcessRunner struct {
	sem chan struct{}
}

type ProcessRunnerOptions struct {
	MaxConcurrent int
}

func NewProcessRunner(opts ProcessRunnerOptions) *ProcessRunner {
	max := opts.MaxConcurrent
	if max <= 0 {
		max = 1
	}
	return &ProcessRunner{sem: make(chan struct{}, max)}
}

func (r *ProcessRunner) Run(ctx context.Context, spec ProcessRunSpec) (ProcessRunResult, error) {
	return r.run(ctx, spec, nil)
}

func (r *ProcessRunner) run(
	ctx context.Context,
	spec ProcessRunSpec,
	onStarted func(startedAt time.Time),
) (ProcessRunResult, error) {
	if err := ValidateProcessRunSpec(spec); err != nil {
		return ProcessRunResult{}, err
	}

	if err := r.acquire(ctx); err != nil {
		return ProcessRunResult{}, err
	}
	defer r.release()

	started := time.Now()
	if onStarted != nil {
		onStarted(started)
	}
	return runProcess(ctx, spec, started)
}

func ValidateProcessRunSpec(spec ProcessRunSpec) error {
	if spec.RunID == "" {
		return errors.New("process runId must be non-empty")
	}
	if spec.WorkspaceID == "" {
		return errors.New("process workspaceId must be non-empty")
	}
	if spec.Command == "" {
		return errors.New("process command must be non-empty")
	}
	if spec.TimeoutMS < 0 {
		return errors.New("process timeoutMs must be non-negative")
	}
	return nil
}

func (r *ProcessRunner) acquire(ctx context.Context) error {
	select {
	case r.sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *ProcessRunner) release() {
	<-r.sem
}

func runProcess(ctx context.Context, spec ProcessRunSpec, started time.Time) (ProcessRunResult, error) {
	runCtx := ctx
	cancel := func() {}
	timedOut := false
	if spec.TimeoutMS > 0 {
		runCtx, cancel = context.WithTimeoutCause(
			ctx,
			time.Duration(spec.TimeoutMS)*time.Millisecond,
			context.DeadlineExceeded,
		)
		defer cancel()
	}

	cmd := exec.CommandContext(runCtx, spec.Command, spec.Args...)
	if spec.Cwd != "" {
		cmd.Dir = spec.Cwd
	}
	cmd.Env = mergeEnv(os.Environ(), spec.Env)
	if spec.Stdin != "" {
		cmd.Stdin = bytes.NewBufferString(spec.Stdin)
	}

	var stdoutCap, stderrCap *limitedCapture
	stdoutCap, _ = newLimitedCapture(spec.RunID, 0, 0)
	stderrCap, _ = newLimitedCapture(spec.RunID, 0, 0)
	defer stdoutCap.Close()
	defer stderrCap.Close()
	cmd.Stdout = stdoutCap
	cmd.Stderr = stderrCap

	err := cmd.Run()
	finished := time.Now()
	if spec.TimeoutMS > 0 && errors.Is(context.Cause(runCtx), context.DeadlineExceeded) {
		timedOut = true
	}
	cancelled := !timedOut && errors.Is(ctx.Err(), context.Canceled)

	status := ProcessRunSucceeded
	var exitCode *int
	var signal string
	if cmd.ProcessState != nil {
		code := cmd.ProcessState.ExitCode()
		exitCode = &code
		if code != 0 {
			status = ProcessRunFailed
		}
		if cmd.ProcessState.Sys() != nil {
			signal = processSignal(cmd.ProcessState)
		}
	} else if err != nil {
		status = ProcessRunFailed
	}
	if timedOut {
		status = ProcessRunTimedOut
	} else if cancelled {
		status = ProcessRunCancelled
	}

	stdoutText, _, stdoutTruncated := stdoutCap.Result()
	stderrText, _, stderrTruncated := stderrCap.Result()

	result := ProcessRunResult{
		RunID:       spec.RunID,
		WorkspaceID: spec.WorkspaceID,
		TaskID:      spec.TaskID,
		Status:      status,
		Command:     spec.Command,
		Args:        append([]string(nil), spec.Args...),
		Cwd:         spec.Cwd,
		Labels:      cloneStringMap(spec.Labels),
		ExitCode:    exitCode,
		Signal:      signal,
		Stdout:      stdoutText,
		Stderr:      stderrText,
		StdoutTruncated: stdoutTruncated,
		StderrTruncated: stderrTruncated,
		StartedAt:   started.UTC().Format(time.RFC3339Nano),
		FinishedAt:  finished.UTC().Format(time.RFC3339Nano),
		DurationMS:  maxInt64(0, finished.Sub(started).Milliseconds()),
		TimedOut:    timedOut,
		Cancelled:   cancelled,
	}

	if err != nil && !isExitLikeError(err) && !timedOut && !cancelled {
		return result, fmt.Errorf("run process %q: %w", spec.RunID, err)
	}
	return result, nil
}

func mergeEnv(base []string, overrides map[string]string) []string {
	if len(overrides) == 0 {
		return base
	}
	env := append([]string(nil), base...)
	for key, value := range overrides {
		env = append(env, key+"="+value)
	}
	return env
}

func cloneStringMap(values map[string]string) map[string]string {
	if len(values) == 0 {
		return nil
	}
	out := make(map[string]string, len(values))
	for key, value := range values {
		out[key] = value
	}
	return out
}

func isExitLikeError(err error) bool {
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr)
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func processSignal(state *os.ProcessState) string {
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return status.Signal().String()
	}
	return ""
}

type ProcessSupervisor struct {
	runner  *ProcessRunner
	mu      sync.Mutex
	runs    map[string]*processRunRecord
	journal *processJournal
}

type processRunRecord struct {
	snapshot ProcessRunSnapshot
	cancel   context.CancelFunc
	done     chan struct{}
}

func NewProcessSupervisor(opts ProcessRunnerOptions, dataDir string) *ProcessSupervisor {
	var journal *processJournal
	if strings.TrimSpace(dataDir) != "" {
		if j, err := newProcessJournal(dataDir); err == nil {
			journal = j
		}
	}
	supervisor := &ProcessSupervisor{
		runner:  NewProcessRunner(opts),
		runs:    map[string]*processRunRecord{},
		journal: journal,
	}
	if journal != nil {
		_ = supervisor.reconcileFromJournal()
	}
	return supervisor
}

func (s *ProcessSupervisor) reconcileFromJournal() error {
	if s.journal == nil {
		return nil
	}
	snapshots, err := s.journal.loadAll()
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, snapshot := range snapshots {
		if snapshot.RunID == "" {
			continue
		}
		if snapshot.State == ProcessRunQueued || snapshot.State == ProcessRunRunning {
			snapshot = reconcileJournalSnapshot(snapshot)
			_ = s.journal.save(snapshot)
		}
		s.runs[snapshot.RunID] = &processRunRecord{
			snapshot: snapshot,
			done:     closedChannel(),
		}
	}
	return nil
}

func (s *ProcessSupervisor) persist(snapshot ProcessRunSnapshot) {
	if s.journal == nil {
		return
	}
	_ = s.journal.save(snapshot)
}

func (s *ProcessSupervisor) Run(ctx context.Context, spec ProcessRunSpec) (ProcessRunResult, error) {
	result, err := s.runner.Run(ctx, spec)
	if result.RunID != "" {
		now := time.Now().UTC().Format(time.RFC3339Nano)
		s.mu.Lock()
		s.runs[result.RunID] = &processRunRecord{
			snapshot: ProcessRunSnapshot{
				RunID:       result.RunID,
				WorkspaceID: result.WorkspaceID,
				TaskID:      result.TaskID,
				State:       ProcessRunFinished,
				Spec:        cloneProcessRunSpec(spec),
				Result:      &result,
				Error:       errorString(err),
				StartedAt:   result.StartedAt,
				FinishedAt:  now,
			},
			done: closedChannel(),
		}
		snapshot := s.cloneSnapshot(s.runs[result.RunID].snapshot)
		s.mu.Unlock()
		s.persist(snapshot)
	}
	return result, err
}

func (s *ProcessSupervisor) Get(runID string) (ProcessRunResult, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.runs[runID]
	if !ok || record.snapshot.Result == nil {
		return ProcessRunResult{}, false
	}
	return *record.snapshot.Result, true
}

func (s *ProcessSupervisor) Start(ctx context.Context, spec ProcessRunSpec) (ProcessRunSnapshot, error) {
	if err := ValidateProcessRunSpec(spec); err != nil {
		return ProcessRunSnapshot{}, err
	}

	runCtx, cancel := context.WithCancel(ctx)
	queuedAt := time.Now().UTC().Format(time.RFC3339Nano)
	record := &processRunRecord{
		snapshot: ProcessRunSnapshot{
			RunID:       spec.RunID,
			WorkspaceID: spec.WorkspaceID,
			TaskID:      spec.TaskID,
			State:       ProcessRunQueued,
			Spec:        cloneProcessRunSpec(spec),
			QueuedAt:    queuedAt,
		},
		cancel: cancel,
		done:   make(chan struct{}),
	}

	s.mu.Lock()
	if _, exists := s.runs[spec.RunID]; exists {
		s.mu.Unlock()
		cancel()
		return ProcessRunSnapshot{}, fmt.Errorf("process run %q already exists", spec.RunID)
	}
	s.runs[spec.RunID] = record
	snapshot := s.cloneSnapshot(record.snapshot)
	s.mu.Unlock()
	s.persist(snapshot)

	go func() {
		result, err := s.runner.run(runCtx, spec, func(startedAt time.Time) {
			s.mu.Lock()
			record.snapshot.State = ProcessRunRunning
			record.snapshot.StartedAt = startedAt.UTC().Format(time.RFC3339Nano)
			runningSnapshot := s.cloneSnapshot(record.snapshot)
			s.mu.Unlock()
			s.persist(runningSnapshot)
		})
		if result.RunID == "" {
			result = processResultFromStartFailure(spec, record.snapshot.QueuedAt, err, runCtx)
		}
		finishedAt := time.Now().UTC().Format(time.RFC3339Nano)
		s.mu.Lock()
		record.snapshot.State = ProcessRunFinished
		record.snapshot.Result = &result
		record.snapshot.Error = errorString(err)
		record.snapshot.FinishedAt = finishedAt
		finishedSnapshot := s.cloneSnapshot(record.snapshot)
		s.mu.Unlock()
		s.persist(finishedSnapshot)
		cancel()
		close(record.done)
	}()

	return s.cloneSnapshot(record.snapshot), nil
}

func (s *ProcessSupervisor) GetSnapshot(runID string) (ProcessRunSnapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.runs[runID]
	if !ok {
		return ProcessRunSnapshot{}, false
	}
	return s.cloneSnapshot(record.snapshot), true
}

func (s *ProcessSupervisor) ListSnapshots(filter ProcessRunListFilter) []ProcessRunSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	snapshots := make([]ProcessRunSnapshot, 0, len(s.runs))
	for _, record := range s.runs {
		snapshot := record.snapshot
		if filter.WorkspaceID != "" && snapshot.WorkspaceID != filter.WorkspaceID {
			continue
		}
		if filter.TaskID != "" && snapshot.TaskID != filter.TaskID {
			continue
		}
		if filter.State != "" && snapshot.State != filter.State {
			continue
		}
		snapshots = append(snapshots, s.cloneSnapshot(snapshot))
	}
	return snapshots
}

func (s *ProcessSupervisor) Wait(ctx context.Context, runID string) (ProcessRunSnapshot, bool, error) {
	s.mu.Lock()
	record, ok := s.runs[runID]
	if !ok {
		s.mu.Unlock()
		return ProcessRunSnapshot{}, false, nil
	}
	done := record.done
	s.mu.Unlock()

	select {
	case <-done:
	case <-ctx.Done():
		return ProcessRunSnapshot{}, true, ctx.Err()
	}

	snapshot, ok := s.GetSnapshot(runID)
	return snapshot, ok, nil
}

func (s *ProcessSupervisor) Cancel(runID string) (ProcessRunSnapshot, bool) {
	s.mu.Lock()
	record, ok := s.runs[runID]
	if !ok {
		s.mu.Unlock()
		return ProcessRunSnapshot{}, false
	}
	if (record.snapshot.State == ProcessRunQueued || record.snapshot.State == ProcessRunRunning) && record.cancel != nil {
		record.cancel()
	}
	snapshot := s.cloneSnapshot(record.snapshot)
	s.mu.Unlock()
	return snapshot, true
}

func (s *ProcessSupervisor) cloneSnapshot(snapshot ProcessRunSnapshot) ProcessRunSnapshot {
	out := snapshot
	out.Spec = cloneProcessRunSpec(snapshot.Spec)
	if snapshot.Result != nil {
		result := *snapshot.Result
		result.Args = append([]string(nil), snapshot.Result.Args...)
		result.Labels = cloneStringMap(snapshot.Result.Labels)
		out.Result = &result
	}
	return out
}

func cloneProcessRunSpec(spec ProcessRunSpec) ProcessRunSpec {
	out := spec
	out.Args = append([]string(nil), spec.Args...)
	out.Env = cloneStringMap(spec.Env)
	out.Labels = cloneStringMap(spec.Labels)
	return out
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func closedChannel() chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}

func processResultFromStartFailure(spec ProcessRunSpec, startedAt string, err error, ctx context.Context) ProcessRunResult {
	finished := time.Now().UTC().Format(time.RFC3339Nano)
	status := ProcessRunFailed
	cancelled := errors.Is(ctx.Err(), context.Canceled)
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	if cancelled {
		status = ProcessRunCancelled
	} else if timedOut {
		status = ProcessRunTimedOut
	}
	return ProcessRunResult{
		RunID:       spec.RunID,
		WorkspaceID: spec.WorkspaceID,
		TaskID:      spec.TaskID,
		Status:      status,
		Command:     spec.Command,
		Args:        append([]string(nil), spec.Args...),
		Cwd:         spec.Cwd,
		Labels:      cloneStringMap(spec.Labels),
		Stdout:      "",
		Stderr:      errorString(err),
		StartedAt:   startedAt,
		FinishedAt:  finished,
		DurationMS:  0,
		TimedOut:    timedOut,
		Cancelled:   cancelled,
	}
}
