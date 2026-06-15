package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/esengine/sikong/internal/store"
)

// ── usage ───────────────────────────────────────────────────────────────────

type usageView struct {
	Total struct {
		InputTokens  int `json:"inputTokens"`
		OutputTokens int `json:"outputTokens"`
		TotalTokens  int `json:"totalTokens"`
		WakeCount    int `json:"wakeCount"`
	} `json:"total"`
	ByProject map[string]struct {
		InputTokens  int `json:"inputTokens"`
		OutputTokens int `json:"outputTokens"`
		TotalTokens  int `json:"totalTokens"`
		WakeCount    int `json:"wakeCount"`
	} `json:"byProject,omitempty"`
	Windows struct {
		Hour5  *usageWindow `json:"5h,omitempty"`
		Day7   *usageWindow `json:"7d,omitempty"`
		Day30  *usageWindow `json:"30d,omitempty"`
	} `json:"windows,omitempty"`
}

type usageWindow struct {
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`
	TotalTokens  int `json:"totalTokens"`
	WakeCount    int `json:"wakeCount"`
}

func runUsage(dir string, args []string) {
	flags, _ := parseFlags(args)
	projectID := flags["--project"]
	text := flags["--text"] != "" || flags["--human"] != ""

	// Read chronicle entries (wake.end / wake.error)
	cs := store.NewJSONLChronicleStore(dir)
	entries, err := cs.Recent(store.ChronicleQuery{Limit: 1000000})
	if err != nil {
		fmt.Fprintf(os.Stderr, "error reading chronicle: %v\n", err)
		os.Exit(1)
	}

	// Read task projections for project mapping
	ps := store.NewJSONProjectionStore(dir)
	tasks, err := ps.Query(store.TaskQuery{})
	if err != nil {
		tasks = nil // non-fatal
	}

	// Build task→project mapping
	taskProject := make(map[string]string)
	for _, t := range tasks {
		taskProject[t.ID] = t.ProjectID
	}

	var view usageView
	view.ByProject = make(map[string]struct {
		InputTokens  int `json:"inputTokens"`
		OutputTokens int `json:"outputTokens"`
		TotalTokens  int `json:"totalTokens"`
		WakeCount    int `json:"wakeCount"`
	})

	now := time.Now()
	for _, e := range entries {
		if e.Type != store.ChronicleWakeEnd && e.Type != store.ChronicleWakeError {
			continue
		}
		if projectID != "" && taskProject[e.TaskID] != projectID {
			continue
		}

		usage, _ := e.Data["usage"].(map[string]interface{})
		inTokens := toInt(usage["inputTokens"])
		outTokens := toInt(usage["outputTokens"])
		totalTokens := toInt(usage["totalTokens"])

		view.Total.WakeCount++
		view.Total.InputTokens += inTokens
		view.Total.OutputTokens += outTokens
		view.Total.TotalTokens += totalTokens

		projID := taskProject[e.TaskID]
		if projID == "" {
			projID = "default"
		}
		p := view.ByProject[projID]
		p.WakeCount++
		p.InputTokens += inTokens
		p.OutputTokens += outTokens
		p.TotalTokens += totalTokens
		view.ByProject[projID] = p

		// Time windows
		age := now.Sub(time.UnixMilli(e.TS))
		addToWindow(&view.Windows.Hour5, e, inTokens, outTokens, totalTokens)
		if age < 7*24*time.Hour {
			addToWindow(&view.Windows.Day7, e, inTokens, outTokens, totalTokens)
		}
		if age < 30*24*time.Hour {
			addToWindow(&view.Windows.Day30, e, inTokens, outTokens, totalTokens)
		}
	}

	if view.Windows.Hour5 == nil {
		view.Windows.Hour5 = &usageWindow{}
	}

	if text {
		fmt.Printf("Usage (tokens)\n")
		fmt.Printf("  Total:    %d in / %d out / %d total (%d wakes)\n",
			view.Total.InputTokens, view.Total.OutputTokens, view.Total.TotalTokens, view.Total.WakeCount)
		if view.Windows.Hour5.WakeCount > 0 {
			fmt.Printf("  5h:       %d in / %d out / %d total (%d wakes)\n",
				view.Windows.Hour5.InputTokens, view.Windows.Hour5.OutputTokens, view.Windows.Hour5.TotalTokens, view.Windows.Hour5.WakeCount)
		}
		if view.Windows.Day7 != nil && view.Windows.Day7.WakeCount > 0 {
			fmt.Printf("  7d:       %d in / %d out / %d total (%d wakes)\n",
				view.Windows.Day7.InputTokens, view.Windows.Day7.OutputTokens, view.Windows.Day7.TotalTokens, view.Windows.Day7.WakeCount)
		}
		if view.Windows.Day30 != nil && view.Windows.Day30.WakeCount > 0 {
			fmt.Printf("  30d:      %d in / %d out / %d total (%d wakes)\n",
				view.Windows.Day30.InputTokens, view.Windows.Day30.OutputTokens, view.Windows.Day30.TotalTokens, view.Windows.Day30.WakeCount)
		}
		return
	}
	json.NewEncoder(os.Stdout).Encode(view)
}

func addToWindow(w **usageWindow, e store.ChronicleEntry, inT, outT, totalT int) {
	if *w == nil {
		*w = &usageWindow{}
	}
	(*w).WakeCount++
	(*w).InputTokens += inT
	(*w).OutputTokens += outT
	(*w).TotalTokens += totalT
}

func toInt(v interface{}) int {
	if v == nil {
		return 0
	}
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	}
	return 0
}
