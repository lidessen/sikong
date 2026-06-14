package daemon

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestProcessAPIShutdownEndpoint(t *testing.T) {
	t.Parallel()

	done := make(chan struct{})
	api := NewProcessAPI(context.Background(), NewProcessSupervisor(ProcessRunnerOptions{}))
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
