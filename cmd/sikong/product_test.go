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
