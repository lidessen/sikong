// Sikong — the coordination layer over agent-loop.
//
// cli+daemon in Go, worker execution in Bun.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/esengine/sikong/internal/acp"
	"github.com/esengine/sikong/internal/store"
)

const version = "0.2.0"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	// services
	case "daemon":
		runDaemon(args)
	case "acp-server":
		runAcpServer(args)

	// project management
	case "project":
		runProject(args)

	// workflow
	case "register":
		runRegister(resolveDir(""), args)

	// task dispatch
	case "task":
		runTask(args)

	// lead conversation
	case "steer":
		runSteer(args)
	case "approve":
		runApprove(args)
	case "reject":
		runReject(args)
	case "cancel":
		runCancel(args)

	// monitoring
	case "status":
		runStatus(args)
	case "trace":
		runTrace(resolveDir(""), args)
	case "chronicle":
		runChronicle(args)
	case "usage":
		runUsage(resolveDir(""), args)
	case "show":
		runShow(args)

	case "help", "--help", "-h":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", cmd)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `sikong v%s

Usage:
  daemon [--dir <path>] [--wake-timeout <ms>]
  acp-server --config <yaml> [--port <n>] [--host <ip>]

  project create <id> --root <path> [--lead <backend> --model <m>]
  project list
  project lead <id> --lead <backend> --model <m>
  register <workflow.yaml>

  task <description> --project <id> [--workflow <id>]
  steer <ref> <message>
  approve <ref>
  reject <ref> --reason <text>
  cancel <ref> --reason <text>

  status [--project <id>]
  trace <ref>
  chronicle [-n <N>] [--project <id>]
  usage [--project <id>]
  show <ref>

  help
`, version)
}

func resolveDir(flagDir string) string {
	if flagDir != "" {
		return flagDir
	}
	if d := os.Getenv("SIKONG_HOME"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".sikong")
}

func parseFlags(args []string) (flags map[string]string, positionals []string) {
	flags = make(map[string]string)
	for i := 0; i < len(args); i++ {
		a := args[i]
		if len(a) > 1 && a[0] == '-' {
			name := a
			val := ""
			for j := 1; j < len(a); j++ {
				if a[j] == '=' {
					name = a[:j]
					val = a[j+1:]
					break
				}
			}
			if val == "" && i+1 < len(args) && !hasPrefix(args[i+1], "-") {
				val = args[i+1]
				i++
			}
			flags[name] = val
		} else {
			positionals = append(positionals, a)
		}
	}
	return
}

func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

// ── service stubs ──────────────────────────────────────────────────────────

func runDaemon(args []string) {
	flags, _ := parseFlags(args)
	dir := resolveDir(flags["--dir"])

	fmt.Fprintf(os.Stderr, "[sikong-daemon] starting (dir: %s pid: %d)\n", dir, os.Getpid())

	ds, err := NewDaemonScheduler(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	if err := ds.StartWorker(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: worker failed to start: %v\n", err)
	}
	defer ds.Stop()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	fmt.Fprintf(os.Stderr, "[sikong-daemon] running (ctrl-c to stop)\n")

	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				ps := store.NewJSONProjectionStore(dir)
				tasks, err := ps.Query(store.TaskQuery{})
				if err != nil {
					continue
				}
				for _, t := range tasks {
					if t.Status == "todo" || t.Status == "in_progress" {
						if err := ds.ExecuteWake(t.ID); err != nil {
							fmt.Fprintf(os.Stderr, "[sikong-daemon] wake %s failed: %v\n", t.ID, err)
						}
					}
				}
			case <-done:
				return
			}
		}
	}()

	<-sigCh
	close(done)
	fmt.Fprintf(os.Stderr, "\n[sikong-daemon] shutting down...\n")
}

func runAcpServer(args []string) {
	flags, _ := parseFlags(args)
	configPath := flags["--config"]
	if configPath == "" {
		configPath = "acp-server.yaml"
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error reading config %s: %v\n", configPath, err)
		os.Exit(1)
	}

	var cfg acp.ServerConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		fmt.Fprintf(os.Stderr, "error parsing config: %v\n", err)
		os.Exit(1)
	}
	if p := flags["--port"]; p != "" {
		fmt.Sscanf(p, "%d", &cfg.Port)
	}
	if h := flags["--host"]; h != "" {
		cfg.Host = h
	}

	server := acp.NewServer(cfg)
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Fprintf(os.Stderr, "\n[acp-server] shutting down...\n")
		server.Close()
		os.Exit(0)
	}()
	if err := server.Listen(); err != nil {
		fmt.Fprintf(os.Stderr, "[acp-server] error: %v\n", err)
		os.Exit(1)
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

func fail(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

func printJSON(v interface{}) {
	json.NewEncoder(os.Stdout).Encode(v)
}
