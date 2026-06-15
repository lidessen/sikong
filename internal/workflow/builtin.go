package workflow

// GeneralWorkflow returns the built-in fallback workflow.
func GeneralWorkflow() WorkflowDef {
	return WorkflowDef{
		ID:          "general",
		Version:     "1",
		Name:        "General",
		Description: "Fallback workflow for any task without a specific one.",
		Fields: map[string]FieldDef{
			"request": {Type: "string", Description: "The original requirement / what was asked."},
			"summary": {Type: "string", Description: "One-line outcome, written when finishing."},
		},
		Stages: []StageDef{
			{
				ID:           "open",
				Category:     StageCategoryInProgress,
				Entry:        Guard{Op: "always"},
				Effort:       "medium",
				OutputFields: []string{"summary"},
				Instructions: "Do whatever the task needs. Record a one-line summary of the outcome, then request a transition to close it.",
			},
			{
				ID:       "done",
				Category: StageCategoryDone,
				Entry:    Guard{Op: "hasEvent", EventType: TaskEventTransitionRequested},
			},
		},
	}
}
