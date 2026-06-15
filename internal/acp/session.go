package acp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sync"
)

// Session represents one ACP session — a run/execute unit with its own
// backend selection, work log, and Bun worker process.
type Session struct {
	ID      string
	Backend string
	WorkLog []WorkLogEntry

	// The Bun worker process handling prompt execution
	worker *WorkerProcess
	running bool
	mu      sync.Mutex
}

// WorkerProcess manages a Bun acp-worker subprocess.
type WorkerProcess struct {
	Cmd   *exec.Cmd
	Stdin io.WriteCloser
	// Channel for receiving events from the worker (goroutine reads stdout)
	Events chan WorkerEvent
	closed bool
	mu     sync.Mutex
}

type WorkerEvent struct {
	Type   string          // "text" | "tool_call" | "tool_call_update" | "usage" | "error" | "end"
	Data   json.RawMessage
}

// WorkersDir is the path to the packages/sikong/src/ directory, resolved
// from the Go module root. Set at startup.
var WorkersDir string

func findWorkerScript() string {
	candidates := []string{
		"packages/sikong/src/acp-worker.ts",
		"../packages/sikong/src/acp-worker.ts",
		"../../packages/sikong/src/acp-worker.ts",
	}
	for _, p := range candidates {
		if pathExists(p) {
			return p
		}
	}
	return "packages/sikong/src/acp-worker.ts"
}

func pathExists(path string) bool {
	_, err := exec.Command("test", "-f", path).Output()
	return err == nil
}

// StartWorker spawns a Bun acp-worker subprocess.
func (s *Session) StartWorker(backendCfg BackendConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.worker != nil {
		return fmt.Errorf("worker already running for session %s", s.ID)
	}

	script := findWorkerScript()
	cmd := exec.Command("bun", script)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	cmd.Stderr = nil // Inherit stderr for debugging

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start worker: %w", err)
	}

	events := make(chan WorkerEvent, 64)
	wp := &WorkerProcess{
		Cmd:    cmd,
		Stdin:  stdin,
		Events: events,
	}

	// Read NDJSON events from worker stdout
	go func() {
		defer close(events)
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}
			var raw struct {
				Type string          `json:"type"`
				Data json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal([]byte(line), &raw); err != nil {
				continue
			}
			events <- WorkerEvent{Type: raw.Type, Data: raw.Data}
		}
	}()

	s.worker = wp
	return nil
}

// SendPrompt sends a prompt to the worker and returns the event channel.
func (s *Session) SendPrompt(prompt string, backendCfg BackendConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.worker == nil {
		return fmt.Errorf("no worker for session %s", s.ID)
	}

	// Build backend config for the worker
	workerCfg := map[string]interface{}{
		"runtime":  backendCfg.Runtime,
		"provider": backendCfg.Provider,
		"model":    backendCfg.Model,
		"apiKey":   backendCfg.APIKey,
	}

	req := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "runPrompt",
		"params": map[string]interface{}{
			"sessionId": s.ID,
			"prompt":    prompt,
			"workLog":   s.WorkLog,
			"worker":    workerCfg,
		},
	}

	s.running = true
	return json.NewEncoder(s.worker.Stdin).Encode(req)
}

// AppendWorkLog adds an entry to the session's work log.
func (s *Session) AppendWorkLog(role, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.WorkLog = append(s.WorkLog, WorkLogEntry{Role: role, Text: text})
}

// StopWorker terminates the worker process.
func (s *Session) StopWorker() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.running = false
	if s.worker != nil {
		s.worker.Close()
		s.worker = nil
	}
}

// Close releases all session resources.
func (s *Session) Close() {
	s.StopWorker()
}

func (wp *WorkerProcess) Close() {
	wp.mu.Lock()
	defer wp.mu.Unlock()
	if wp.closed {
		return
	}
	wp.closed = true
	wp.Stdin.Close()
	if wp.Cmd.Process != nil {
		wp.Cmd.Process.Kill()
	}
}
