package cli

import (
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/lidessen/shilu/pkg/source"
	"github.com/lidessen/shilu/pkg/types"
)

var captureCmd = &cobra.Command{
	Use:   "capture",
	Short: "Capture raw knowledge from external sources",
	Long: `Capture raw knowledge from external sources into the Shilu source registry.

Supported formats:
  manual   Capture from a markdown or text file
  codex    Capture from a Codex session JSONL file
`,
}

var captureManualCmd = &cobra.Command{
	Use:   "manual <file>",
	Short: "Capture from a markdown or text file",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runCapture("manual", args[0])
	},
}

var captureCodexCmd = &cobra.Command{
	Use:   "codex <file>",
	Short: "Capture from a Codex session JSONL file",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runCapture("codex", args[0])
	},
}

func init() {
	captureCmd.AddCommand(captureManualCmd)
	captureCmd.AddCommand(captureCodexCmd)
}

func runCapture(sourceType, path string) error {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("file not found: %s", path)
		}
		return fmt.Errorf("stat file: %w", err)
	}
	if info.IsDir() {
		return fmt.Errorf("%s is a directory, not a file", path)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read file: %w", err)
	}
	if len(data) == 0 {
		return fmt.Errorf("file is empty: %s", path)
	}

	typeCode := types.SourceTypeManual
	if sourceType == "codex" {
		typeCode = types.SourceTypeCodex
	}

	src := &types.Source{
		ID:         types.NewSourceID(),
		Type:       typeCode,
		Origin:     fmt.Sprintf("file:%s", path),
		CapturedAt: time.Now(),
		RawPath:    path,
		Status:     types.SourceStatusCaptured,
	}

	if err := source.Normalize(src); err != nil {
		return fmt.Errorf("normalize source: %w", err)
	}

	fmt.Printf("Captured source: %s\n", src.ID)
	fmt.Printf("  Type:     %s\n", src.Type)
	fmt.Printf("  Origin:   %s\n", src.Origin)
	fmt.Printf("  File:     %s\n", src.RawPath)
	fmt.Printf("  Size:     %d bytes\n", len(data))
	fmt.Printf("  Status:   %s\n", src.Status)
	fmt.Println()
	fmt.Println("To process into entries, use:")
	fmt.Printf("  shilu job enqueue --type digest-source --input sourceId=%s\n", src.ID)

	return nil
}
