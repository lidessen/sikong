package main

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/esengine/sikong/internal/store"
)

var validID = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func isValidID(id string) bool {
	return validID.MatchString(id)
}

func runProject(args []string) {
	dir, args := extractDirFlag(args)
	if len(args) == 0 {
		fail("usage: sikong project create|list|lead")
	}

	sub := args[0]
	subArgs := args[1:]

	switch sub {
	case "create":
		runProjectCreate(dir, subArgs)
	case "list":
		runProjectList(dir)
	case "lead":
		runProjectLead(dir, subArgs)
	default:
		fail("unknown project subcommand: %s", sub)
	}
}

func extractDirFlag(args []string) (string, []string) {
	dir := resolveDir("")
	rest := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--dir" {
			if i+1 >= len(args) {
				fail("--dir requires a value")
			}
			dir = resolveDir(args[i+1])
			i++
			continue
		}
		if strings.HasPrefix(arg, "--dir=") {
			dir = resolveDir(strings.TrimPrefix(arg, "--dir="))
			continue
		}
		rest = append(rest, arg)
	}
	return dir, rest
}

func runProjectCreate(dir string, args []string) {
	flags, positionals := parseFlags(args)
	if len(positionals) < 1 {
		fail("usage: sikong project create <id> --root <path> [--lead <backend>] [--model <m>]")
	}
	id := positionals[0]
	if !isValidID(id) {
		fail("invalid project id %q", id)
	}

	root := flags["--root"]
	if root == "" {
		fail("--root is required")
	}

	ps := store.NewJSONProjectStore(dir)

	// Check for existing
	if existing, _ := ps.Get(id); existing != nil {
		fail("project %q already exists", id)
	}

	proj := store.Project{
		ID:   id,
		Name: id,
		Root: root,
	}

	// Optional lead configuration
	if lead := flags["--lead"]; lead != "" {
		proj.Lead = &store.LeadConfig{
			Backend: lead,
			Model:   flags["--model"],
		}
	}

	if err := ps.Put(proj); err != nil {
		fail("error: %v", err)
	}
	printJSON(map[string]interface{}{
		"ok":   true,
		"id":   id,
		"root": root,
		"dir":  filepath.Dir(ps.MemoryPath(id)),
	})
}

func runProjectList(dir string) {
	ps := store.NewJSONProjectStore(dir)
	projects, err := ps.List()
	if err != nil {
		fail("error: %v", err)
	}
	if len(projects) == 0 {
		fmt.Println("(no projects)")
		return
	}
	for _, p := range projects {
		leadInfo := ""
		if p.Lead != nil {
			leadInfo = fmt.Sprintf("  lead=%s/%s", p.Lead.Backend, p.Lead.Model)
		}
		fmt.Printf("%s  root=%s%s\n", p.ID, p.Root, leadInfo)
	}
}

func runProjectLead(dir string, args []string) {
	flags, positionals := parseFlags(args)
	if len(positionals) < 1 {
		fail("usage: sikong project lead <id> --lead <backend> --model <m>")
	}
	id := positionals[0]
	if !isValidID(id) {
		fail("invalid project id %q", id)
	}

	lead := flags["--lead"]
	if lead == "" {
		fail("--lead is required (codex|claude-code|cursor|ai-sdk)")
	}

	ps := store.NewJSONProjectStore(dir)
	proj, err := ps.Get(id)
	if err != nil {
		fail("error: %v", err)
	}
	if proj == nil {
		fail("project %q not found", id)
	}

	proj.Lead = &store.LeadConfig{
		Backend: lead,
		Model:   flags["--model"],
	}

	if err := ps.Put(*proj); err != nil {
		fail("error: %v", err)
	}
	printJSON(map[string]interface{}{
		"ok":    true,
		"id":    id,
		"lead":  lead,
		"model": proj.Lead.Model,
	})
}
