package daemon

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"
)

func TestRunWithOptionsStartsAndStopsLocalAPI(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(20*time.Millisecond, cancel)

	var out bytes.Buffer
	if err := RunWithOptions(ctx, &out, RunOptions{Addr: "127.0.0.1:0"}); err != nil {
		t.Fatalf("RunWithOptions returned error: %v", err)
	}
	text := out.String()
	if !strings.Contains(text, "sikong daemon listening on http://127.0.0.1:0") {
		t.Fatalf("output = %q, want listening line", text)
	}
	if !strings.Contains(text, "sikong daemon stopped") {
		t.Fatalf("output = %q, want stopped line", text)
	}
}
