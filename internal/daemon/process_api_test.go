package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestProcessAPIShutdownEndpoint(t *testing.T) {
	t.Parallel()

	done := make(chan struct{})
	api := NewProcessAPI(context.Background(), NewProcessSupervisor(ProcessRunnerOptions{}, ""))
	api.SetShutdownFunc(func() {
		close(done)
	})

	req := httptest.NewRequest(http.MethodPost, "/shutdown", nil)
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown callback was not called")
	}
}

func TestProcessAPISchedulerUnavailable(t *testing.T) {
	t.Parallel()

	api := NewProcessAPI(context.Background(), NewProcessSupervisor(ProcessRunnerOptions{}, ""))

	statusReq := httptest.NewRequest(http.MethodGet, "/scheduler/status", nil)
	statusRec := httptest.NewRecorder()
	api.ServeHTTP(statusRec, statusReq)

	if statusRec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", statusRec.Code, http.StatusOK, statusRec.Body.String())
	}
	var status SchedulerStatus
	if err := json.Unmarshal(statusRec.Body.Bytes(), &status); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if status.Enabled {
		t.Fatalf("scheduler status enabled = true, want false")
	}

	wakeReq := httptest.NewRequest(http.MethodPost, "/scheduler/wake", nil)
	wakeRec := httptest.NewRecorder()
	api.ServeHTTP(wakeRec, wakeReq)

	if wakeRec.Code != http.StatusServiceUnavailable {
		t.Fatalf("wake status = %d, want %d; body = %s", wakeRec.Code, http.StatusServiceUnavailable, wakeRec.Body.String())
	}
}
