package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

const (
	DaemonAddrEnv     = "SIKONG_DAEMON_ADDR"
	DefaultDaemonAddr = "127.0.0.1:8765"
)

type RunOptions struct {
	Addr             string
	MaxConcurrent    int
	DisableScheduler bool
}

func Run(ctx context.Context, out io.Writer) error {
	return RunWithOptions(ctx, out, RunOptions{Addr: os.Getenv(DaemonAddrEnv)})
}

func RunWithOptions(ctx context.Context, out io.Writer, opts RunOptions) error {
	addr := opts.Addr
	if addr == "" {
		addr = DefaultDaemonAddr
	}

	runCtx, stop := context.WithCancel(ctx)
	defer stop()

	scheduler := NewScheduler(runCtx, SchedulerOptions{
		Addr:          addr,
		MaxConcurrent: 2,
	})
	api := NewProcessAPI(runCtx, NewProcessSupervisor(ProcessRunnerOptions{
		MaxConcurrent: opts.MaxConcurrent,
	}))
	if !opts.DisableScheduler {
		api.SetScheduler(scheduler)
		scheduler.Start()
	}
	api.SetShutdownFunc(stop)
	server := &http.Server{
		Addr:              addr,
		Handler:           api,
		ReadHeaderTimeout: 5 * time.Second,
	}
	errs := make(chan error, 1)

	go func() {
		err := server.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- err
			return
		}
		errs <- nil
	}()

	fmt.Fprintf(out, "sikong daemon listening on http://%s\n", addr)

	select {
	case <-runCtx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return err
		}
		fmt.Fprintln(out, "sikong daemon stopped")
		return nil
	case err := <-errs:
		return err
	}
}
