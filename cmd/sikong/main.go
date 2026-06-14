package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"sikong/internal/buildinfo"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "-v", "--version", "version":
			fmt.Println(buildinfo.VersionString("sikong"))
			return
		case "-h", "--help", "help":
			printUsage()
			return
		}
	}

	if len(os.Args) == 1 {
		printUsage()
		return
	}

	if err := runWorkspaceCLI(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`sikong

Usage:
  sikong [--version]
  sikong workspace ...
  sikong preference ...
  sikong task ...
  sikong inspect ...

The command adapter delegates to packages/workspace command handlers.`)
}

func runWorkspaceCLI(args []string) error {
	root, err := findRepoRoot()
	if err != nil {
		return err
	}
	script := filepath.Join(root, "packages", "workspace", "src", "cli", "index.ts")
	cmd := exec.Command("bun", append([]string{script}, args...)...)
	cmd.Dir = root
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		return fmt.Errorf("failed to run workspace CLI adapter: %w", err)
	}
	return nil
}

func findRepoRoot() (string, error) {
	candidates := []string{}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Dir(exe))
	}

	for _, candidate := range candidates {
		if root, ok := walkForWorkspaceCLI(candidate); ok {
			return root, nil
		}
	}
	return "", fmt.Errorf("could not locate packages/workspace/src/cli/index.ts")
}

func walkForWorkspaceCLI(start string) (string, bool) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", false
	}
	for {
		script := filepath.Join(dir, "packages", "workspace", "src", "cli", "index.ts")
		if _, err := os.Stat(script); err == nil {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}
