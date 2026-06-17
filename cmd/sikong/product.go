package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
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
	json       bool
	timeout    time.Duration
}

type logsOptions struct {
	includeDaemon bool
	includeUI     bool
	lines         int
	follow        bool
	json          bool
	raw           bool
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
			return fmt.Errorf("daemon did not become healthy before timeout; inspect logs with `sikong logs --daemon --lines 200`")
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
			return fmt.Errorf("web UI did not become healthy before timeout; inspect logs with `sikong logs --ui --lines 200`")
		}
	} else {
		state.UI.URL = uiURL
		state.UI.Port = opts.uiPort
	}

	state.Version = buildinfo.Version()
	state.Updated = time.Now().UTC().Format(time.RFC3339)
	state = withDefaultLogPaths(state)
	if err := writeState(state); err != nil {
		return err
	}
	if !opts.noOpen {
		openBrowser(uiURL)
	}
	payload := map[string]any{
		"ok": true,
		"data": map[string]any{
			"version": buildinfo.Version(),
			"daemon": map[string]any{
				"url":     daemonURL,
				"running": daemonRunning,
				"health":  daemonHealth,
				"logPath": state.Daemon.LogPath,
			},
			"ui": map[string]any{
				"url":     uiURL,
				"port":    opts.uiPort,
				"running": uiRunning,
				"health":  uiHealth,
				"logPath": state.UI.LogPath,
			},
		},
	}
	if opts.json {
		return printJSON(payload)
	}
	fmt.Print(formatStartText(daemonURL, uiURL))
	return nil
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
	payload := map[string]any{
		"ok": true,
		"data": map[string]any{
			"daemon": map[string]any{"url": daemonURL, "shutdown": shutdownOK},
			"ui":     map[string]any{"pid": state.UI.PID, "stopped": uiStopped},
		},
	}
	if opts.json {
		return printJSON(payload)
	}
	fmt.Print(formatStopText(daemonURL, shutdownOK, state.UI.PID, uiStopped))
	return nil
}

func runStatus(args []string) error {
	opts, err := parseProductOptions(args)
	if err != nil {
		return err
	}
	state, _ := readState()
	state = withDefaultLogPaths(state)
	daemonURL := daemonBaseURL(opts.daemonAddr)
	daemonHealth, daemonRunning := checkJSONHealth(daemonURL + "/health")
	uiURL := "http://127.0.0.1:" + opts.uiPort
	uiHealth, uiRunning := checkJSONHealth(uiURL + "/api/health")
	payload := map[string]any{
		"ok": true,
		"data": map[string]any{
			"version": buildinfo.Version(),
			"daemon": map[string]any{
				"url":     daemonURL,
				"running": daemonRunning,
				"health":  daemonHealth,
				"pid":     state.Daemon.PID,
				"logPath": state.Daemon.LogPath,
			},
			"ui": map[string]any{
				"url":     uiURL,
				"port":    opts.uiPort,
				"running": uiRunning,
				"health":  uiHealth,
				"pid":     state.UI.PID,
				"logPath": state.UI.LogPath,
			},
		},
	}
	if opts.json {
		return printJSON(payload)
	}
	fmt.Print(formatStatusText(daemonURL, daemonRunning, uiURL, uiRunning))
	return nil
}

func runLogs(args []string) error {
	opts, err := parseLogsOptions(args)
	if err != nil {
		return err
	}
	state, _ := readState()
	state = withDefaultLogPaths(state)
	paths, err := resolveLogPaths(state, opts)
	if err != nil {
		return err
	}
	if opts.json {
		payload := map[string]any{"ok": true, "data": map[string]any{"logs": paths}}
		return printJSON(payload)
	}
	if opts.raw {
		for index, log := range paths {
			if index > 0 {
				fmt.Println()
			}
			fmt.Printf("==> %s (%s) <==\n", log.Name, log.Path)
			if err := printRawLogTail(log.Path, opts.lines); err != nil {
				fmt.Fprintf(os.Stderr, "could not read %s log: %v\n", log.Name, err)
			}
		}
	} else {
		fmt.Printf("Sikong logs - last %d lines per source\n", opts.lines)
		fmt.Println("TIME     SOURCE LEVEL COMPONENT          MESSAGE")
		for _, log := range paths {
			if err := printFormattedLogTail(log, opts.lines); err != nil {
				fmt.Fprintf(os.Stderr, "could not read %s log: %v\n", log.Name, err)
			}
		}
	}
	if opts.follow {
		return followLogs(paths, opts.raw)
	}
	return nil
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
		case arg == "--json":
			opts.json = true
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

func parseLogsOptions(args []string) (logsOptions, error) {
	opts := logsOptions{includeDaemon: true, includeUI: true, lines: 200}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--daemon":
			opts.includeDaemon = true
			opts.includeUI = false
		case arg == "--ui" || arg == "--web":
			opts.includeDaemon = false
			opts.includeUI = true
		case arg == "--all":
			opts.includeDaemon = true
			opts.includeUI = true
		case arg == "--follow" || arg == "-f":
			opts.follow = true
		case arg == "--json":
			opts.json = true
		case arg == "--raw":
			opts.raw = true
		case arg == "--lines" || arg == "-n":
			if i+1 >= len(args) {
				return opts, fmt.Errorf("%s requires a value", arg)
			}
			i++
			lines, err := parseLogLines(args[i])
			if err != nil {
				return opts, err
			}
			opts.lines = lines
		case strings.HasPrefix(arg, "--lines="):
			lines, err := parseLogLines(strings.TrimPrefix(arg, "--lines="))
			if err != nil {
				return opts, err
			}
			opts.lines = lines
		case strings.HasPrefix(arg, "-n="):
			lines, err := parseLogLines(strings.TrimPrefix(arg, "-n="))
			if err != nil {
				return opts, err
			}
			opts.lines = lines
		default:
			return opts, fmt.Errorf("unknown logs option %q", arg)
		}
	}
	if !opts.includeDaemon && !opts.includeUI {
		return opts, fmt.Errorf("at least one log target is required")
	}
	return opts, nil
}

func parseLogLines(value string) (int, error) {
	lines, err := strconv.Atoi(value)
	if err != nil || lines < 0 {
		return 0, fmt.Errorf("--lines must be a non-negative integer")
	}
	return lines, nil
}

func formatStartText(daemonURL string, uiURL string) string {
	return fmt.Sprintf("Sikong started\nDaemon: %s\nUI: %s\n", daemonURL, uiURL)
}

func formatStopText(daemonURL string, shutdownOK bool, uiPID int, uiStopped bool) string {
	daemonStatus := "stopped"
	if !shutdownOK {
		daemonStatus = "not running"
	}
	uiStatus := "not tracked"
	if uiPID > 0 {
		if uiStopped {
			uiStatus = "stopped"
		} else {
			uiStatus = "not running"
		}
	}
	return fmt.Sprintf("Sikong stopped\nDaemon: %s (%s)\nUI: %s\n", daemonURL, daemonStatus, uiStatus)
}

func formatStatusText(daemonURL string, daemonRunning bool, uiURL string, uiRunning bool) string {
	daemonStatus := "stopped"
	if daemonRunning {
		daemonStatus = "running"
	}
	uiStatus := "stopped"
	if uiRunning {
		uiStatus = "running"
	}
	return fmt.Sprintf(
		"Sikong %s\nDaemon: %s (%s)\nUI: %s (%s)\nLogs: sikong logs --lines 200\n",
		buildinfo.Version(),
		daemonURL,
		daemonStatus,
		uiURL,
		uiStatus,
	)
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
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = logFile.Close()
		return processState{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = logFile.Close()
		return processState{}, err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return processState{}, err
	}
	copyManagedProcessLogs(cmd, logFile, stdout, stderr)
	return processState{
		PID:       cmd.Process.Pid,
		URL:       url,
		Port:      port,
		LogPath:   logPath,
		StartedAt: time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func copyManagedProcessLogs(cmd *exec.Cmd, logFile *os.File, stdout io.Reader, stderr io.Reader) {
	sink := &timestampedLogSink{file: logFile}
	var copies sync.WaitGroup
	copies.Add(2)
	go func() {
		defer copies.Done()
		writer := &timestampedLogWriter{sink: sink}
		_, _ = io.Copy(writer, stdout)
		writer.Flush()
	}()
	go func() {
		defer copies.Done()
		writer := &timestampedLogWriter{sink: sink}
		_, _ = io.Copy(writer, stderr)
		writer.Flush()
	}()
	go func() {
		copies.Wait()
		_ = cmd.Wait()
		_ = logFile.Close()
	}()
}

type timestampedLogSink struct {
	file *os.File
	mu   sync.Mutex
}

func (s *timestampedLogSink) WriteLine(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = fmt.Fprintf(s.file, "%s %s\n", time.Now().UTC().Format(time.RFC3339), text)
}

type timestampedLogWriter struct {
	sink   logLineSink
	buffer []byte
}

type logLineSink interface {
	WriteLine(text string)
}

func (w *timestampedLogWriter) Write(p []byte) (int, error) {
	for _, b := range p {
		if b == '\n' {
			w.Flush()
			continue
		}
		w.buffer = append(w.buffer, b)
	}
	return len(p), nil
}

func (w *timestampedLogWriter) Flush() {
	if len(w.buffer) == 0 {
		return
	}
	w.sink.WriteLine(string(w.buffer))
	w.buffer = w.buffer[:0]
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

func withDefaultLogPaths(state sikongState) sikongState {
	if state.Daemon.LogPath == "" {
		if path, err := runLogPath("daemon"); err == nil {
			state.Daemon.LogPath = path
		}
	}
	if state.UI.LogPath == "" {
		if path, err := runLogPath("ui"); err == nil {
			state.UI.LogPath = path
		}
	}
	return state
}

type namedLogPath struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func resolveLogPaths(state sikongState, opts logsOptions) ([]namedLogPath, error) {
	paths := []namedLogPath{}
	if opts.includeDaemon {
		path := state.Daemon.LogPath
		if path == "" {
			var err error
			path, err = runLogPath("daemon")
			if err != nil {
				return nil, err
			}
		}
		paths = append(paths, namedLogPath{Name: "daemon", Path: path})
	}
	if opts.includeUI {
		path := state.UI.LogPath
		if path == "" {
			var err error
			path, err = runLogPath("ui")
			if err != nil {
				return nil, err
			}
		}
		paths = append(paths, namedLogPath{Name: "ui", Path: path})
	}
	return paths, nil
}

func printRawLogTail(path string, lines int) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if lines > 0 {
		data = tailLines(data, lines)
	} else {
		data = nil
	}
	if len(data) == 0 {
		return nil
	}
	_, err = os.Stdout.Write(data)
	if err == nil && data[len(data)-1] != '\n' {
		fmt.Println()
	}
	return err
}

func printFormattedLogTail(log namedLogPath, lines int) error {
	data, err := os.ReadFile(log.Path)
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Println(formatLogLine(logLine{Source: log.Name, Level: "WARN", Component: "log", Message: "log file does not exist: " + log.Path}))
			return nil
		}
		return err
	}
	if lines > 0 {
		data = tailLines(data, lines)
	} else {
		data = nil
	}
	entries := parseLogData(log.Name, data)
	if len(entries) == 0 {
		fmt.Println(formatLogLine(logLine{Source: log.Name, Level: "INFO", Component: "log", Message: "no log entries: " + log.Path}))
		return nil
	}
	for _, entry := range entries {
		fmt.Println(formatLogLine(entry))
	}
	return nil
}

type logLine struct {
	Source    string
	Time      string
	Level     string
	Component string
	Message   string
}

func parseLogData(source string, data []byte) []logLine {
	lines := bytes.Split(data, []byte{'\n'})
	entries := make([]logLine, 0, len(lines))
	for _, raw := range lines {
		text := strings.TrimSpace(string(raw))
		if text == "" {
			continue
		}
		entries = append(entries, parseLogLine(source, text))
	}
	return entries
}

func parseLogLine(source string, text string) logLine {
	timestamp, text := splitLogTimestamp(text)
	component := source
	message := text
	if strings.HasPrefix(text, "$ ") {
		return logLine{Source: source, Time: timestamp, Level: "CMD", Component: "shell", Message: strings.TrimPrefix(text, "$ ")}
	}
	if strings.HasPrefix(text, "@") {
		if prefix, rest, ok := strings.Cut(text, ":"); ok {
			component = strings.TrimPrefix(prefix, "@sikong/")
			message = strings.TrimSpace(rest)
		}
	}
	return logLine{
		Source:    source,
		Time:      timestamp,
		Level:     inferLogLevel(text),
		Component: component,
		Message:   message,
	}
}

func inferLogLevel(text string) string {
	lower := strings.ToLower(text)
	switch {
	case strings.Contains(lower, "error") ||
		strings.Contains(lower, "failed") ||
		strings.Contains(lower, "panic") ||
		strings.Contains(lower, "uncaughtexception") ||
		strings.Contains(lower, "unhandledrejection"):
		return "ERROR"
	case strings.Contains(lower, "warn") ||
		strings.Contains(lower, "timeout") ||
		strings.Contains(lower, "cancelled") ||
		strings.Contains(lower, "stopped"):
		return "WARN"
	default:
		return "INFO"
	}
}

func formatLogLine(entry logLine) string {
	return fmt.Sprintf(
		"%-8s %-6s %-5s %-18s %s",
		formatLogTime(entry.Time),
		truncateLogField(entry.Source, 6),
		truncateLogField(entry.Level, 5),
		truncateLogField(entry.Component, 18),
		entry.Message,
	)
}

func splitLogTimestamp(text string) (string, string) {
	candidate, rest, ok := strings.Cut(text, " ")
	if !ok {
		return "", text
	}
	if _, err := time.Parse(time.RFC3339, candidate); err != nil {
		return "", text
	}
	return candidate, strings.TrimSpace(rest)
}

func formatLogTime(value string) string {
	if value == "" {
		return "--:--:--"
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return "--:--:--"
	}
	return parsed.Local().Format("15:04:05")
}

func truncateLogField(value string, width int) string {
	if len(value) <= width {
		return value
	}
	if width <= 3 {
		return value[:width]
	}
	return value[:width-3] + "..."
}

func tailLines(data []byte, lines int) []byte {
	if lines <= 0 || len(data) == 0 {
		return nil
	}
	seen := 0
	for index := len(data) - 1; index >= 0; index-- {
		if data[index] == '\n' {
			if index == len(data)-1 {
				continue
			}
			seen++
			if seen == lines {
				return data[index+1:]
			}
		}
	}
	return data
}

func followLogs(paths []namedLogPath, raw bool) error {
	positions := map[string]int64{}
	for _, log := range paths {
		info, err := os.Stat(log.Path)
		if err == nil {
			positions[log.Path] = info.Size()
		}
	}
	for {
		for _, log := range paths {
			pos := positions[log.Path]
			next, err := copyLogFrom(log, pos, raw)
			if err != nil {
				continue
			}
			positions[log.Path] = next
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func copyLogFrom(log namedLogPath, offset int64, raw bool) (int64, error) {
	file, err := os.Open(log.Path)
	if err != nil {
		return offset, err
	}
	defer file.Close()
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return offset, err
	}
	if raw {
		wrapped := &prefixedWriter{prefix: []byte("[" + log.Name + "] "), atLineStart: true}
		if _, err := io.Copy(wrapped, file); err != nil {
			return offset, err
		}
	} else {
		wrapped := &formattedLogWriter{source: log.Name}
		if _, err := io.Copy(wrapped, file); err != nil {
			return offset, err
		}
	}
	pos, err := file.Seek(0, io.SeekCurrent)
	if err != nil {
		return offset, err
	}
	return pos, nil
}

type formattedLogWriter struct {
	source string
	buffer []byte
}

func (w *formattedLogWriter) Write(p []byte) (int, error) {
	for _, b := range p {
		if b == '\n' {
			w.flush()
			continue
		}
		w.buffer = append(w.buffer, b)
	}
	return len(p), nil
}

func (w *formattedLogWriter) flush() {
	text := strings.TrimSpace(string(w.buffer))
	w.buffer = w.buffer[:0]
	if text == "" {
		return
	}
	fmt.Println(formatLogLine(parseLogLine(w.source, text)))
}

type prefixedWriter struct {
	prefix      []byte
	atLineStart bool
}

func (w *prefixedWriter) Write(p []byte) (int, error) {
	for _, b := range p {
		if w.atLineStart {
			if _, err := os.Stdout.Write(w.prefix); err != nil {
				return 0, err
			}
			w.atLineStart = false
		}
		if _, err := os.Stdout.Write([]byte{b}); err != nil {
			return 0, err
		}
		if b == '\n' {
			w.atLineStart = true
		}
	}
	return len(p), nil
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
