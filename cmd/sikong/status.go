package main

import (
	"fmt"

	"github.com/esengine/sikong/internal/store"
)

func runStatus(args []string) {
	flags, _ := parseFlags(args)
	dir := resolveDir(flags["--dir"])
	projectID := flags["--project"]

	ps := store.NewJSONProjectionStore(dir)
	tasks, err := ps.Query(store.TaskQuery{ProjectID: projectID})
	if err != nil {
		fail("error: %v", err)
	}

	type taskInfo struct {
		ID         string `json:"id"`
		ProjectID  string `json:"projectId"`
		WorkflowID string `json:"workflowId"`
		StageID    string `json:"stageId"`
		Status     string `json:"status"`
		Summary    string `json:"summary,omitempty"`
	}

	byStatus := make(map[string]int)
	var infos []taskInfo
	for _, t := range tasks {
		byStatus[string(t.Status)]++
		summary, _ := t.Fields["summary"].(string)
		infos = append(infos, taskInfo{
			ID:         t.ID,
			ProjectID:  t.ProjectID,
			WorkflowID: t.WorkflowID,
			StageID:    t.StageID,
			Status:     string(t.Status),
			Summary:    summary,
		})
	}

	cs := store.NewJSONLChronicleStore(dir)
	entries, _ := cs.Recent(store.ChronicleQuery{Limit: 10})

	result := map[string]interface{}{
		"total":    len(tasks),
		"byStatus": byStatus,
		"tasks":    infos,
		"recent":   entries,
	}
	if projectID != "" {
		result["projectId"] = projectID
	}
	printJSON(result)
}

func runChronicle(args []string) {
	flags, positionals := parseFlags(args)
	dir := resolveDir(flags["--dir"])

	// Support @ref as positional
	taskID := ""
	if len(positionals) > 0 {
		ref := positionals[0]
		taskID = ref
	}
	if taskID == "" {
		taskID = flags["--task"]
	}

	limit := 30
	if flags["-n"] != "" {
		fmt.Sscanf(flags["-n"], "%d", &limit)
	}

	cs := store.NewJSONLChronicleStore(dir)
	entries, err := cs.Recent(store.ChronicleQuery{
		TaskID: taskID,
		Limit:  limit,
	})
	if err != nil {
		fail("error: %v", err)
	}
	printJSON(entries)
}
