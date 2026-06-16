package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"sikong/internal/buildinfo"
	"sikong/internal/runtimebundle"
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
		case "start":
			if err := runStart(os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		case "stop":
			if err := runStop(os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		case "status":
			if err := runStatus(os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		case "ui":
			if err := runClientUI(os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
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
  sikong start [--daemon <addr>] [--ui-port <port>] [--no-open]
  sikong stop [--daemon <addr>]
  sikong status [--daemon <addr>] [--ui-port <port>]
  sikong workspace ...
  sikong preference ...
  sikong task ...
  sikong inspect ...
  sikong daemon ...
  sikong ui [--port <port>] [--no-build]

The command adapter delegates to packages/workspace command handlers.`)
}

func runClientUI(args []string) error {
	runtime, ok, err := loadEmbeddedRuntime()
	if err != nil {
		return err
	}
	root, err := findRepoRoot()
	if err != nil && !ok {
		return err
	}
	env := os.Environ()
	build := true
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--no-build":
			build = false
		case arg == "--port":
			if i+1 >= len(args) {
				return fmt.Errorf("--port requires a value")
			}
			i++
			env = append(env, "SIKONG_CLIENT_API_PORT="+args[i])
		case len(arg) > len("--port=") && arg[:len("--port=")] == "--port=":
			env = append(env, "SIKONG_CLIENT_API_PORT="+arg[len("--port="):])
		default:
			return fmt.Errorf("unknown ui option %q", arg)
		}
	}
	if ok {
		env = appendRuntimeEnv(env, runtime)
		cmd := exec.Command(runtime.ClientAPI)
		cmd.Dir = runtime.Root
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Env = env
		if err := cmd.Run(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				os.Exit(exitErr.ExitCode())
			}
			return fmt.Errorf("failed to run Sikong UI server: %w", err)
		}
		return nil
	}
	if build {
		buildCmd := exec.Command("bun", "--filter", "@sikong/client", "build")
		buildCmd.Dir = root
		buildCmd.Stdin = os.Stdin
		buildCmd.Stdout = os.Stdout
		buildCmd.Stderr = os.Stderr
		buildCmd.Env = env
		if err := buildCmd.Run(); err != nil {
			return fmt.Errorf("failed to build Sikong UI: %w", err)
		}
	}
	cmd := exec.Command("bun", "--filter", "@sikong/client", "api")
	cmd.Dir = root
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = env
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		return fmt.Errorf("failed to run Sikong UI server: %w", err)
	}
	return nil
}

func runWorkspaceCLI(args []string) error {
	runtime, ok, err := loadEmbeddedRuntime()
	if err != nil {
		return err
	}
	if ok {
		cmd := exec.Command(runtime.WorkspaceCLI, args...)
		cmd.Dir = runtime.Root
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Env = appendRuntimeEnv(os.Environ(), runtime)

		if err := cmd.Run(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				os.Exit(exitErr.ExitCode())
			}
			return fmt.Errorf("failed to run workspace CLI adapter: %w", err)
		}
		return nil
	}
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

func loadEmbeddedRuntime() (runtimebundle.Paths, bool, error) {
	return runtimebundle.Extract(buildinfo.Version())
}

func appendRuntimeEnv(env []string, runtime runtimebundle.Paths) []string {
	return append(
		env,
		"SIKONG_RUNTIME_DIR="+runtime.Root,
		"SIKONG_WORKSPACE_CLI_COMMAND="+runtime.WorkspaceCLI,
		"SIKONG_CLIENT_DIST_DIR="+runtime.ClientDist,
		"SIKONG_ORCHESTRATION_RUNNER_COMMAND="+runtime.OrchestrationRunner,
		"SIKONG_PROCESS_RUNNER_COMMAND="+runtime.ProcessRunner,
		"SIKONG_PACKAGE_CWD="+runtime.Root,
	)
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
