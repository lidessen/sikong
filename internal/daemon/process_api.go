package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type ProcessAPI struct {
	ctx        context.Context
	supervisor *ProcessSupervisor
	shutdown   func()
}

func NewProcessAPI(ctx context.Context, supervisor *ProcessSupervisor) *ProcessAPI {
	if ctx == nil {
		ctx = context.Background()
	}
	if supervisor == nil {
		supervisor = NewProcessSupervisor(ProcessRunnerOptions{})
	}
	return &ProcessAPI{ctx: ctx, supervisor: supervisor}
}

func (api *ProcessAPI) SetShutdownFunc(shutdown func()) {
	api.shutdown = shutdown
}

func (api *ProcessAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/health":
		api.handleHealth(w, r)
	case r.URL.Path == "/shutdown":
		api.handleShutdown(w, r)
	case r.URL.Path == "/process-runs":
		api.handleProcessRuns(w, r)
	case strings.HasPrefix(r.URL.Path, "/process-runs/"):
		api.handleProcessRun(w, r)
	default:
		writeProcessAPIError(w, http.StatusNotFound, "not_found", "route not found")
	}
}

func (api *ProcessAPI) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeProcessAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	writeProcessAPIJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (api *ProcessAPI) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeProcessAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if api.shutdown == nil {
		writeProcessAPIError(w, http.StatusServiceUnavailable, "shutdown_unavailable", "shutdown is unavailable")
		return
	}
	writeProcessAPIJSON(w, http.StatusOK, map[string]bool{"ok": true})
	go api.shutdown()
}

func (api *ProcessAPI) handleProcessRuns(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeProcessAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	defer r.Body.Close()

	var spec ProcessRunSpec
	if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
		writeProcessAPIError(w, http.StatusBadRequest, "invalid_json", "invalid JSON body")
		return
	}
	snapshot, err := api.supervisor.Start(api.ctx, spec)
	if err != nil {
		writeProcessAPIError(w, http.StatusBadRequest, "invalid_process_run", err.Error())
		return
	}
	writeProcessAPIJSON(w, http.StatusAccepted, snapshot)
}

func (api *ProcessAPI) handleProcessRun(w http.ResponseWriter, r *http.Request) {
	runID, action, ok := parseProcessRunPath(r.URL.Path)
	if !ok {
		writeProcessAPIError(w, http.StatusNotFound, "not_found", "route not found")
		return
	}

	switch action {
	case "":
		if r.Method != http.MethodGet {
			writeProcessAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
			return
		}
		api.getProcessRun(w, runID)
	case "wait":
		if r.Method != http.MethodGet {
			writeProcessAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
			return
		}
		api.waitProcessRun(w, r, runID)
	case "cancel":
		if r.Method != http.MethodPost {
			writeProcessAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
			return
		}
		api.cancelProcessRun(w, runID)
	default:
		writeProcessAPIError(w, http.StatusNotFound, "not_found", "route not found")
	}
}

func (api *ProcessAPI) getProcessRun(w http.ResponseWriter, runID string) {
	snapshot, ok := api.supervisor.GetSnapshot(runID)
	if !ok {
		writeProcessAPIError(w, http.StatusNotFound, "not_found", "process run not found")
		return
	}
	writeProcessAPIJSON(w, http.StatusOK, snapshot)
}

func (api *ProcessAPI) waitProcessRun(w http.ResponseWriter, r *http.Request, runID string) {
	ctx := r.Context()
	if timeoutMS := r.URL.Query().Get("timeoutMs"); timeoutMS != "" {
		timeout, err := strconv.ParseInt(timeoutMS, 10, 64)
		if err != nil || timeout < 0 {
			writeProcessAPIError(w, http.StatusBadRequest, "invalid_timeout", "timeoutMs must be non-negative")
			return
		}
		if timeout > 0 {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
			defer cancel()
		}
	}

	snapshot, ok, err := api.supervisor.Wait(ctx, runID)
	if !ok {
		writeProcessAPIError(w, http.StatusNotFound, "not_found", "process run not found")
		return
	}
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			writeProcessAPIError(w, http.StatusGatewayTimeout, "wait_timeout", "process run did not finish before timeout")
			return
		}
		writeProcessAPIError(w, http.StatusInternalServerError, "wait_failed", err.Error())
		return
	}
	writeProcessAPIJSON(w, http.StatusOK, snapshot)
}

func (api *ProcessAPI) cancelProcessRun(w http.ResponseWriter, runID string) {
	snapshot, ok := api.supervisor.Cancel(runID)
	if !ok {
		writeProcessAPIError(w, http.StatusNotFound, "not_found", "process run not found")
		return
	}
	writeProcessAPIJSON(w, http.StatusOK, snapshot)
}

func parseProcessRunPath(path string) (string, string, bool) {
	trimmed := strings.Trim(strings.TrimPrefix(path, "/process-runs/"), "/")
	if trimmed == "" {
		return "", "", false
	}
	parts := strings.Split(trimmed, "/")
	if len(parts) > 2 {
		return "", "", false
	}
	runID, err := url.PathUnescape(parts[0])
	if err != nil || runID == "" {
		return "", "", false
	}
	if len(parts) == 1 {
		return runID, "", true
	}
	return runID, parts[1], true
}

func writeProcessAPIJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeProcessAPIError(w http.ResponseWriter, status int, code string, message string) {
	writeProcessAPIJSON(w, status, map[string]map[string]string{
		"error": {
			"code":    code,
			"message": message,
		},
	})
}
