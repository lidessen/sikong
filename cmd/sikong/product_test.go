package main

import (
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

	opts, err := parseLogsOptions([]string{"--ui", "--lines", "50", "--follow"})
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
