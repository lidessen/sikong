package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	workspaceCLICommandEnv           = "SIKONG_WORKSPACE_CLI_COMMAND"
	sikongDataDirEnv                 = "SIKONG_DATA_DIR"
	schedulerProcessTimeoutMSEnv     = "SIKONG_SCHEDULER_PROCESS_TIMEOUT_MS"
	schedulerWaitTimeoutMSEnv        = "SIKONG_SCHEDULER_WAIT_TIMEOUT_MS"
	defaultSchedulerProcessTimeoutMS = int64(2 * 60 * 60 * 1000)
	defaultSchedulerWaitTimeoutMS    = defaultSchedulerProcessTimeoutMS + int64(60*1000)
)

type SchedulerOptions struct {
	Addr             string
	DataDir          string
	MaxConcurrent    int
	PollInterval     time.Duration
	Command          string
	Cwd              string
	ProcessTimeoutMS int64
	WaitTimeoutMS    int64
}

type Scheduler struct {
	ctx          context.Context
	opts         SchedulerOptions
	wake         chan struct{}
	sem          chan struct{}
	mu           sync.Mutex
	paused       bool
	active       map[string]bool
	lastScanAt   string
	lastTickAt   string
	lastError    string
	completed    int
	started      int
	runnableSeen int
}

type SchedulerStatus struct {
	Enabled          bool     `json:"enabled"`
	Paused           bool     `json:"paused"`
	Active           int      `json:"active"`
	MaxConcurrent    int      `json:"maxConcurrent"`
	LastScanAt       string   `json:"lastScanAt,omitempty"`
	LastTickAt       string   `json:"lastTickAt,omitempty"`
	LastError        string   `json:"lastError,omitempty"`
	Started          int      `json:"started"`
	Completed        int      `json:"completed"`
	RunnableSeen     int      `json:"runnableSeen"`
	ActiveTasks      []string `json:"activeTasks,omitempty"`
	ProcessTimeoutMS int64    `json:"processTimeoutMs"`
	WaitTimeoutMS    int64    `json:"waitTimeoutMs"`
}

type runnableCLIOutput struct {
	OK   bool `json:"ok"`
	Data struct {
		Tasks []runnableTask `json:"tasks"`
	} `json:"data"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type runnableTask struct {
	WorkspaceID string `json:"workspaceId"`
	TaskID      string `json:"taskId"`
}

func NewScheduler(ctx context.Context, opts SchedulerOptions) *Scheduler {
	if ctx == nil {
		ctx = context.Background()
	}
	if opts.MaxConcurrent <= 0 {
		opts.MaxConcurrent = DefaultDaemonTaskMaxConcurrent
	}
	if opts.PollInterval <= 0 {
		opts.PollInterval = 15 * time.Second
	}
	if opts.DataDir == "" {
		opts.DataDir = defaultSchedulerDataDir()
	}
	if opts.ProcessTimeoutMS <= 0 {
		opts.ProcessTimeoutMS = schedulerTimeoutFromEnv(schedulerProcessTimeoutMSEnv, defaultSchedulerProcessTimeoutMS)
	}
	if opts.WaitTimeoutMS <= 0 {
		opts.WaitTimeoutMS = schedulerTimeoutFromEnv(schedulerWaitTimeoutMSEnv, defaultSchedulerWaitTimeoutMS)
	}
	return &Scheduler{
		ctx:    ctx,
		opts:   opts,
		wake:   make(chan struct{}, 1),
		sem:    make(chan struct{}, opts.MaxConcurrent),
		active: map[string]bool{},
	}
}

func (s *Scheduler) Start() {
	go s.loop()
	go s.signalWatchLoop()
	s.Wake()
}

func (s *Scheduler) Wake() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Scheduler) Pause() {
	s.mu.Lock()
	s.paused = true
	s.mu.Unlock()
}

func (s *Scheduler) Resume() {
	s.mu.Lock()
	s.paused = false
	s.mu.Unlock()
	s.Wake()
}

func (s *Scheduler) Status() SchedulerStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	active := make([]string, 0, len(s.active))
	for key := range s.active {
		active = append(active, key)
	}
	return SchedulerStatus{
		Enabled:          true,
		Paused:           s.paused,
		Active:           len(s.active),
		MaxConcurrent:    s.opts.MaxConcurrent,
		LastScanAt:       s.lastScanAt,
		LastTickAt:       s.lastTickAt,
		LastError:        s.lastError,
		Started:          s.started,
		Completed:        s.completed,
		RunnableSeen:     s.runnableSeen,
		ActiveTasks:      active,
		ProcessTimeoutMS: s.opts.ProcessTimeoutMS,
		WaitTimeoutMS:    s.opts.WaitTimeoutMS,
	}
}

func (s *Scheduler) RunnableTasks(ctx context.Context) ([]runnableTask, error) {
	return s.runnableTasks(ctx)
}

func (s *Scheduler) loop() {
	ticker := time.NewTicker(s.opts.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.wake:
			s.scanAndStart()
		case <-ticker.C:
			s.scanAndStart()
		}
	}
}

func (s *Scheduler) signalWatchLoop() {
	signalPath := filepath.Join(s.opts.DataDir, "daemon", "scheduler.signal")
	var lastMod time.Time
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			info, err := os.Stat(signalPath)
			if err != nil {
				continue
			}
			if info.ModTime().After(lastMod) {
				lastMod = info.ModTime()
				s.Wake()
			}
		}
	}
}

func (s *Scheduler) scanAndStart() {
	if s.isPaused() {
		return
	}
	s.setScan(time.Now())
	tasks, err := s.runnableTasks(s.ctx)
	if err != nil {
		s.setError(err)
		return
	}
	s.clearError()
	s.setRunnableSeen(len(tasks))
	for _, task := range tasks {
		key := task.WorkspaceID + "/" + task.TaskID
		if !s.tryStart(key) {
			continue
		}
		select {
		case s.sem <- struct{}{}:
			go s.runTick(key, task)
		default:
			s.finishActive(key, false, nil)
			return
		}
	}
}

func (s *Scheduler) runTick(key string, task runnableTask) {
	var tickErr error
	defer func() {
		<-s.sem
		s.finishActive(key, tickErr == nil, tickErr)
		s.Wake()
	}()
	_, stderr, err := s.runCLI(
		s.ctx,
		"--json",
		"task",
		"tick",
		task.TaskID,
		"--workspace",
		task.WorkspaceID,
		"--daemon",
		s.opts.Addr,
		"--process-timeout-ms",
		strconv.FormatInt(s.opts.ProcessTimeoutMS, 10),
		"--wait-timeout-ms",
		strconv.FormatInt(s.opts.WaitTimeoutMS, 10),
	)
	if err != nil {
		if strings.TrimSpace(stderr) != "" {
			err = errors.New(strings.TrimSpace(stderr))
		}
		tickErr = err
		s.setError(err)
		return
	}
	s.clearError()
}

func (s *Scheduler) runnableTasks(ctx context.Context) ([]runnableTask, error) {
	stdout, stderr, err := s.runCLI(ctx, "--json", "task", "runnable", "--all")
	if err != nil {
		if strings.TrimSpace(stderr) != "" {
			return nil, errors.New(strings.TrimSpace(stderr))
		}
		return nil, err
	}
	var output runnableCLIOutput
	if err := json.Unmarshal([]byte(stdout), &output); err != nil {
		return nil, err
	}
	if !output.OK {
		if output.Error != nil {
			return nil, errors.New(output.Error.Message)
		}
		return nil, errors.New("task runnable command failed")
	}
	return output.Data.Tasks, nil
}

func (s *Scheduler) runCLI(ctx context.Context, args ...string) (string, string, error) {
	command, commandArgs, cwd := s.command(args...)
	cmd := exec.CommandContext(ctx, command, commandArgs...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Env = schedulerEnv(s.opts)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

func (s *Scheduler) command(args ...string) (string, []string, string) {
	if s.opts.Command != "" {
		return s.opts.Command, args, s.opts.Cwd
	}
	if command := os.Getenv(workspaceCLICommandEnv); command != "" {
		return command, args, s.opts.Cwd
	}
	if root, ok := findSchedulerRepoRoot(s.opts.Cwd); ok {
		script := filepath.Join(root, "packages", "workspace", "src", "cli", "index.ts")
		return "bun", append([]string{script}, args...), root
	}
	return "sikong-workspace-cli", args, s.opts.Cwd
}

func (s *Scheduler) isPaused() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.paused
}

func (s *Scheduler) tryStart(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.paused || s.active[key] {
		return false
	}
	s.active[key] = true
	s.started++
	s.lastTickAt = time.Now().UTC().Format(time.RFC3339Nano)
	return true
}

func (s *Scheduler) finishActive(key string, completed bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.active, key)
	if completed {
		s.completed++
	}
	if err != nil {
		s.lastError = err.Error()
	}
}

func (s *Scheduler) setScan(t time.Time) {
	s.mu.Lock()
	s.lastScanAt = t.UTC().Format(time.RFC3339Nano)
	s.mu.Unlock()
}

func (s *Scheduler) setError(err error) {
	if err == nil {
		return
	}
	s.mu.Lock()
	s.lastError = err.Error()
	s.mu.Unlock()
}

func (s *Scheduler) clearError() {
	s.mu.Lock()
	s.lastError = ""
	s.mu.Unlock()
}

func (s *Scheduler) setRunnableSeen(count int) {
	s.mu.Lock()
	s.runnableSeen = count
	s.mu.Unlock()
}

func schedulerEnv(opts SchedulerOptions) []string {
	env := os.Environ()
	if opts.Addr != "" {
		env = append(env, DaemonAddrEnv+"="+opts.Addr)
	}
	if opts.DataDir != "" {
		env = append(env, sikongDataDirEnv+"="+opts.DataDir)
	}
	return env
}

func defaultSchedulerDataDir() string {
	if value := strings.TrimSpace(os.Getenv(sikongDataDirEnv)); value != "" {
		return value
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".sikong"
	}
	return filepath.Join(home, ".sikong")
}

func schedulerTimeoutFromEnv(name string, fallback int64) int64 {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func findSchedulerRepoRoot(start string) (string, bool) {
	candidates := []string{}
	if start != "" {
		candidates = append(candidates, start)
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}
	for _, candidate := range candidates {
		dir, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		for {
			script := filepath.Join(dir, "packages", "workspace", "src", "cli", "index.ts")
			if _, err := os.Stat(script); err == nil {
				return dir, true
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", false
}
