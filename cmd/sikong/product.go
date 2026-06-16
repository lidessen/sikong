package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"sikong/internal/buildinfo"
	"sikong/internal/runtimebundle"
)

const (
	defaultDaemonAddr = "127.0.0.1:8765"
	defaultUIPort     = "8776"
)

type productOptions struct {
	daemonAddr string
	uiPort     string
	noOpen     bool
	timeout    time.Duration
}

type managedRuntime struct {
	embedded bool
	paths    runtimebundle.Paths
	repoRoot string
}

type processState struct {
	PID       int    `json:"pid,omitempty"`
	URL       string `json:"url,omitempty"`
	Port      string `json:"port,omitempty"`
	LogPath   string `json:"logPath,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
}

type sikongState struct {
	Version string       `json:"version"`
	Daemon  processState `json:"daemon,omitempty"`
	UI      processState `json:"ui,omitempty"`
	Updated string       `json:"updatedAt"`
}

func runStart(args []string) error {
	opts, err := parseProductOptions(args)
	if err != nil {
		return err
	}
	rt, err := resolveManagedRuntime()
	if err != nil {
		return err
	}
	state, _ := readState()

	daemonURL := daemonBaseURL(opts.daemonAddr)
	daemonHealth, daemonRunning := checkJSONHealth(daemonURL + "/health")
	if !daemonRunning {
		proc, err := startDaemon(rt, opts.daemonAddr)
		if err != nil {
			return err
		}
		state.Daemon = proc
		daemonHealth, daemonRunning = waitForHealth(daemonURL+"/health", opts.timeout)
		if !daemonRunning {
			return fmt.Errorf("daemon did not become healthy before timeout")
		}
	} else {
		state.Daemon.URL = daemonURL
	}

	uiURL := "http://127.0.0.1:" + opts.uiPort
	uiHealth, uiRunning := checkJSONHealth(uiURL + "/api/health")
	if !uiRunning {
		proc, err := startUI(rt, opts.uiPort, opts.daemonAddr)
		if err != nil {
			return err
		}
		state.UI = proc
		uiHealth, uiRunning = waitForHealth(uiURL+"/api/health", opts.timeout)
		if !uiRunning {
			return fmt.Errorf("web UI did not become healthy before timeout")
		}
	} else {
		state.UI.URL = uiURL
		state.UI.Port = opts.uiPort
	}

	state.Version = buildinfo.Version()
	state.Updated = time.Now().UTC().Format(time.RFC3339)
	if err := writeState(state); err != nil {
		return err
	}
	if !opts.noOpen {
		openBrowser(uiURL)
	}
	return printJSON(map[string]any{
		"ok": true,
		"data": map[string]any{
			"version": buildinfo.Version(),
			"daemon": map[string]any{
				"url":     daemonURL,
				"running": daemonRunning,
				"health":  daemonHealth,
			},
			"ui": map[string]any{
				"url":     uiURL,
				"port":    opts.uiPort,
				"running": uiRunning,
				"health":  uiHealth,
			},
		},
	})
}

func runStop(args []string) error {
	opts, err := parseProductOptions(args)
	if err != nil {
		return err
	}
	state, _ := readState()
	uiStopped := stopPID(state.UI.PID)
	daemonURL := daemonBaseURL(opts.daemonAddr)
	shutdownOK := postShutdown(daemonURL + "/shutdown")
	state.Updated = time.Now().UTC().Format(time.RFC3339)
	_ = writeState(state)
	return printJSON(map[string]any{
		"ok": true,
		"data": map[string]any{
			"daemon": map[string]any{"url": daemonURL, "shutdown": shutdownOK},
			"ui":     map[string]any{"pid": state.UI.PID, "stopped": uiStopped},
		},
	})
}

func runStatus(args []string) error {
	opts, err := parseProductOptions(args)
	if err != nil {
		return err
	}
	state, _ := readState()
	daemonURL := daemonBaseURL(opts.daemonAddr)
	daemonHealth, daemonRunning := checkJSONHealth(daemonURL + "/health")
	uiURL := "http://127.0.0.1:" + opts.uiPort
	uiHealth, uiRunning := checkJSONHealth(uiURL + "/api/health")
	return printJSON(map[string]any{
		"ok": true,
		"data": map[string]any{
			"version": buildinfo.Version(),
			"daemon": map[string]any{
				"url":     daemonURL,
				"running": daemonRunning,
				"health":  daemonHealth,
				"pid":     state.Daemon.PID,
			},
			"ui": map[string]any{
				"url":     uiURL,
				"port":    opts.uiPort,
				"running": uiRunning,
				"health":  uiHealth,
				"pid":     state.UI.PID,
			},
		},
	})
}

func parseProductOptions(args []string) (productOptions, error) {
	opts := productOptions{daemonAddr: defaultDaemonAddr, uiPort: defaultUIPort, timeout: 10 * time.Second}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--daemon":
			if i+1 >= len(args) {
				return opts, fmt.Errorf("--daemon requires a value")
			}
			i++
			opts.daemonAddr = args[i]
		case strings.HasPrefix(arg, "--daemon="):
			opts.daemonAddr = strings.TrimPrefix(arg, "--daemon=")
		case arg == "--ui-port" || arg == "--web-port":
			if i+1 >= len(args) {
				return opts, fmt.Errorf("%s requires a value", arg)
			}
			i++
			opts.uiPort = args[i]
		case strings.HasPrefix(arg, "--ui-port="):
			opts.uiPort = strings.TrimPrefix(arg, "--ui-port=")
		case strings.HasPrefix(arg, "--web-port="):
			opts.uiPort = strings.TrimPrefix(arg, "--web-port=")
		case arg == "--no-open":
			opts.noOpen = true
		case arg == "--timeout-ms":
			if i+1 >= len(args) {
				return opts, fmt.Errorf("--timeout-ms requires a value")
			}
			i++
			timeout, err := strconv.Atoi(args[i])
			if err != nil || timeout < 0 {
				return opts, fmt.Errorf("--timeout-ms must be a non-negative integer")
			}
			opts.timeout = time.Duration(timeout) * time.Millisecond
		case strings.HasPrefix(arg, "--timeout-ms="):
			timeout, err := strconv.Atoi(strings.TrimPrefix(arg, "--timeout-ms="))
			if err != nil || timeout < 0 {
				return opts, fmt.Errorf("--timeout-ms must be a non-negative integer")
			}
			opts.timeout = time.Duration(timeout) * time.Millisecond
		default:
			return opts, fmt.Errorf("unknown option %q", arg)
		}
	}
	return opts, nil
}

func resolveManagedRuntime() (managedRuntime, error) {
	paths, ok, err := loadEmbeddedRuntime()
	if err != nil {
		return managedRuntime{}, err
	}
	if ok {
		return managedRuntime{embedded: true, paths: paths}, nil
	}
	root, err := findRepoRoot()
	if err != nil {
		return managedRuntime{}, err
	}
	return managedRuntime{repoRoot: root}, nil
}

func startDaemon(rt managedRuntime, addr string) (processState, error) {
	env := append(os.Environ(), "SIKONG_DAEMON_ADDR="+daemonAddr(addr))
	if rt.embedded {
		env = appendRuntimeEnv(env, rt.paths)
		return startManagedProcess(rt.paths.Daemon, nil, rt.paths.Root, env, "daemon", daemonBaseURL(addr), "")
	}
	return startManagedProcess("go", []string{"run", "./cmd/sikongd"}, rt.repoRoot, env, "daemon", daemonBaseURL(addr), "")
}

func startUI(rt managedRuntime, port string, daemonAddrValue string) (processState, error) {
	env := append(
		os.Environ(),
		"SIKONG_CLIENT_API_PORT="+port,
		"SIKONG_DAEMON_ADDR="+daemonAddr(daemonAddrValue),
	)
	if rt.embedded {
		env = appendRuntimeEnv(env, rt.paths)
		return startManagedProcess(rt.paths.ClientAPI, nil, rt.paths.Root, env, "ui", "http://127.0.0.1:"+port, port)
	}
	return startManagedProcess("go", []string{"run", "./cmd/sikong", "ui", "--port", port}, rt.repoRoot, env, "ui", "http://127.0.0.1:"+port, port)
}

func startManagedProcess(command string, args []string, cwd string, env []string, name string, url string, port string) (processState, error) {
	logPath, err := runLogPath(name)
	if err != nil {
		return processState{}, err
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return processState{}, err
	}
	cmd := exec.Command(command, args...)
	cmd.Dir = cwd
	cmd.Env = env
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return processState{}, err
	}
	_ = logFile.Close()
	return processState{
		PID:       cmd.Process.Pid,
		URL:       url,
		Port:      port,
		LogPath:   logPath,
		StartedAt: time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func daemonBaseURL(addr string) string {
	raw := addr
	if raw == "" {
		raw = defaultDaemonAddr
	}
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		return strings.TrimRight(raw, "/")
	}
	return "http://" + strings.TrimRight(raw, "/")
}

func daemonAddr(addr string) string {
	raw := addr
	if raw == "" {
		raw = defaultDaemonAddr
	}
	raw = strings.TrimPrefix(raw, "http://")
	raw = strings.TrimPrefix(raw, "https://")
	return strings.TrimRight(raw, "/")
}

func checkJSONHealth(url string) (map[string]any, bool) {
	client := http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Get(url)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}, false
	}
	defer resp.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if body == nil {
			body = map[string]any{"ok": false, "status": resp.StatusCode}
		}
		return body, false
	}
	if body == nil {
		body = map[string]any{"ok": true}
	}
	return body, true
}

func waitForHealth(url string, timeout time.Duration) (map[string]any, bool) {
	deadline := time.Now().Add(timeout)
	for {
		health, ok := checkJSONHealth(url)
		if ok {
			return health, true
		}
		if time.Now().After(deadline) {
			return health, false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func postShutdown(url string) bool {
	resp, err := http.Post(url, "application/json", bytes.NewBufferString("{}"))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

func stopPID(pid int) bool {
	if pid <= 0 {
		return false
	}
	if err := syscall.Kill(-pid, syscall.SIGTERM); err == nil {
		return true
	}
	if proc, err := os.FindProcess(pid); err == nil {
		return proc.Signal(syscall.SIGTERM) == nil
	}
	return false
}

func openBrowser(url string) {
	if runtime.GOOS != "darwin" {
		return
	}
	_ = exec.Command("open", url).Start()
}

func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func statePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".sikong", "run", "sikong.json"), nil
}

func runLogPath(name string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".sikong", "run")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return filepath.Join(dir, name+".log"), nil
}

func readState() (sikongState, error) {
	path, err := statePath()
	if err != nil {
		return sikongState{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return sikongState{}, err
	}
	var state sikongState
	if err := json.Unmarshal(data, &state); err != nil {
		return sikongState{}, err
	}
	return state, nil
}

func writeState(state sikongState) error {
	path, err := statePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}
