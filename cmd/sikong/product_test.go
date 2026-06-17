package main

import (
	"os"
	"strings"
	"testing"
)

func TestParseProductOptionsJSON(t *testing.T) {
	t.Parallel()
	opts, err := parseProductOptions([]string{
		"--daemon",
		"127.0.0.1:9999",
		"--ui-port=8888",
		"--no-open",
		"--json",
	})
	if err != nil {
		t.Fatalf("parseProductOptions returned error: %v", err)
	}
	if opts.daemonAddr != "127.0.0.1:9999" {
		t.Fatalf("daemonAddr = %q", opts.daemonAddr)
	}
	if opts.uiPort != "8888" {
		t.Fatalf("uiPort = %q", opts.uiPort)
	}
	if !opts.noOpen {
		t.Fatal("noOpen = false")
	}
	if !opts.json {
		t.Fatal("json = false")
	}
}

func TestFormatProductOutputIsHumanReadable(t *testing.T) {
	t.Parallel()

	start := formatStartText("http://127.0.0.1:8765", "http://127.0.0.1:8776")
	if !strings.Contains(start, "Sikong started") || strings.Contains(start, "{") {
		t.Fatalf("start output = %q", start)
	}

	stop := formatStopText("http://127.0.0.1:8765", true, 1234, true)
	if !strings.Contains(stop, "Sikong stopped") || strings.Contains(stop, "{") {
		t.Fatalf("stop output = %q", stop)
	}

	status := formatStatusText("http://127.0.0.1:8765", true, "http://127.0.0.1:8776", false)
	if !strings.Contains(status, "Daemon: http://127.0.0.1:8765 (running)") ||
		strings.Contains(status, "{") {
		t.Fatalf("status output = %q", status)
	}
}

func TestParseLogsOptions(t *testing.T) {
	t.Parallel()

	opts, err := parseLogsOptions([]string{"--ui", "--lines", "50", "--follow", "--raw"})
	if err != nil {
		t.Fatalf("parseLogsOptions returned error: %v", err)
	}
	if opts.includeDaemon {
		t.Fatal("includeDaemon = true")
	}
	if !opts.includeUI {
		t.Fatal("includeUI = false")
	}
	if opts.lines != 50 {
		t.Fatalf("lines = %d", opts.lines)
	}
	if !opts.follow {
		t.Fatal("follow = false")
	}
	if !opts.raw {
		t.Fatal("raw = false")
	}
}

func TestTailLines(t *testing.T) {
	t.Parallel()

	got := string(tailLines([]byte("a\nb\nc\n"), 2))
	if got != "b\nc\n" {
		t.Fatalf("tailLines = %q", got)
	}

	got = string(tailLines([]byte("a\nb\nc"), 2))
	if got != "b\nc" {
		t.Fatalf("tailLines without final newline = %q", got)
	}

	got = string(tailLines([]byte("a\nb\n"), 10))
	if got != "a\nb\n" {
		t.Fatalf("tailLines all = %q", got)
	}
}

func TestResolveLogPathsUsesStateAndFallback(t *testing.T) {
	t.Parallel()

	paths, err := resolveLogPaths(sikongState{
		UI: processState{LogPath: "/tmp/sikong-ui.log"},
	}, logsOptions{includeDaemon: true, includeUI: true})
	if err != nil {
		t.Fatalf("resolveLogPaths returned error: %v", err)
	}
	if len(paths) != 2 {
		t.Fatalf("len(paths) = %d", len(paths))
	}
	if paths[0].Name != "daemon" || !strings.HasSuffix(paths[0].Path, "daemon.log") {
		t.Fatalf("daemon path = %#v", paths[0])
	}
	if paths[1].Name != "ui" || paths[1].Path != "/tmp/sikong-ui.log" {
		t.Fatalf("ui path = %#v", paths[1])
	}
}

func TestParseAndFormatLogLine(t *testing.T) {
	t.Parallel()

	entry := parseLogLine("ui", "2026-06-17T04:05:06+08:00 @sikong/client api: sikong client api listening on http://127.0.0.1:8776")
	if entry.Source != "ui" ||
		entry.Time != "2026-06-17T04:05:06+08:00" ||
		entry.Level != "INFO" ||
		entry.Component != "client api" {
		t.Fatalf("entry = %#v", entry)
	}
	formatted := formatLogLine(entry)
	if !strings.Contains(formatted, "04:05:06") ||
		!strings.Contains(formatted, "ui") ||
		!strings.Contains(formatted, "INFO") ||
		!strings.Contains(formatted, "client api") ||
		!strings.Contains(formatted, "sikong client api listening") {
		t.Fatalf("formatted = %q", formatted)
	}

	failed := parseLogLine("ui", "@sikong/client api: Error: Failed to start server")
	if failed.Level != "ERROR" {
		t.Fatalf("failed level = %q", failed.Level)
	}

	command := parseLogLine("ui", "$ go run ./cmd/sikong ui --no-build")
	if command.Level != "CMD" || command.Component != "shell" {
		t.Fatalf("command = %#v", command)
	}
	if !strings.HasPrefix(formatLogLine(command), "--:--:--") {
		t.Fatalf("untimed command formatted = %q", formatLogLine(command))
	}
}

func TestTimestampedLogWriterPrefixesLines(t *testing.T) {
	t.Parallel()

	file, err := os.CreateTemp(t.TempDir(), "log-*.txt")
	if err != nil {
		t.Fatalf("CreateTemp returned error: %v", err)
	}
	defer file.Close()
	sink := &timestampedLogSink{file: file}
	writer := &timestampedLogWriter{sink: sink}
	if _, err := writer.Write([]byte("first\nsecond")); err != nil {
		t.Fatalf("Write returned error: %v", err)
	}
	writer.Flush()
	data, err := os.ReadFile(file.Name())
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines = %#v", lines)
	}
	for _, line := range lines {
		timestamp, rest := splitLogTimestamp(line)
		if timestamp == "" || rest == "" {
			t.Fatalf("line missing timestamp = %q", line)
		}
	}
}
