package daemon

import (
	"context"
	"fmt"
	"io"
)

func Run(ctx context.Context, out io.Writer) error {
	fmt.Fprintln(out, "sikong daemon initialized")
	<-ctx.Done()
	fmt.Fprintln(out, "sikong daemon stopped")
	return nil
}
