package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/esengine/sikong/internal/protocol"
	"github.com/esengine/sikong/internal/workflow"
)

var supportedCommandTools = []string{"set_field", "request_transition", "append_note", "block", "cancel"}

func buildWakeTaskContext(task workflow.Task, wf workflow.WorkflowDef) protocol.WakeTaskContext {
	stage := workflow.StageByID(wf, task.StageID)
	tools := buildStageCommandTools(wf, stage)
	effort := task.Effort
	if effort == "" && stage != nil {
		effort = stage.Effort
	}
	if effort == "" {
		effort = "medium"
	}

	return protocol.WakeTaskContext{
		TaskID:       task.ID,
		WorkflowID:   task.WorkflowID,
		WorkflowVer:  task.WorkflowVersion,
		StageID:      task.StageID,
		SystemPrompt: buildWakeSystemPrompt(task, wf, stage, tools),
		UserPrompt:   buildWakeUserPrompt(task),
		Tools:        tools,
		MaxSteps:     20,
		Effort:       effort,
	}
}

func buildWakeSystemPrompt(task workflow.Task, wf workflow.WorkflowDef, stage *workflow.StageDef, tools map[string]protocol.ToolDef) string {
	lines := []string{
		fmt.Sprintf("# Workflow: %s", wf.Name),
		wf.Description,
	}
	if stage != nil && strings.TrimSpace(stage.Instructions) != "" {
		lines = append(lines, "", "## Stage", stage.Instructions)
	}

	fieldNames := sortedFieldNames(wf.Fields)
	if len(fieldNames) > 0 {
		lines = append(lines, "", "## Fields")
		for _, name := range fieldNames {
			def := wf.Fields[name]
			line := fmt.Sprintf("- %s (%s)", name, def.Type)
			if def.Description != "" {
				line += " - " + def.Description
			}
			lines = append(lines, line)
		}
	}

	toolNames := sortedToolNames(tools)
	lines = append(lines,
		"",
		"## How to make progress",
		fmt.Sprintf("Tools available this stage: %s.", inlineTools(toolNames)),
		"Update the task's state with these tools. When this stage's work is done, call `request_transition`. The workflow decides whether the task advances.",
		"",
		"## Task identity",
		fmt.Sprintf("You are advancing task %s, currently in stage %q.", task.ID, task.StageID),
	)
	return strings.Join(lines, "\n")
}

func buildWakeUserPrompt(task workflow.Task) string {
	fields := task.Fields
	if fields == nil {
		fields = map[string]interface{}{}
	}
	data, err := json.MarshalIndent(fields, "", "  ")
	if err != nil {
		data = []byte("{}")
	}
	return fmt.Sprintf("Advance this task from its current state.\n\nCurrent fields:\n%s", string(data))
}

func buildStageCommandTools(wf workflow.WorkflowDef, stage *workflow.StageDef) map[string]protocol.ToolDef {
	allowed := allowedCommandTools(stage)
	tools := make(map[string]protocol.ToolDef)
	for _, name := range supportedCommandTools {
		if !allowed[name] {
			continue
		}
		switch name {
		case "set_field":
			fields := writableFieldNames(wf, stage)
			if len(fields) == 0 {
				continue
			}
			tools[name] = protocol.ToolDef{
				Description: "Set one of this stage's writable task fields.",
				InputSchema: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"field": map[string]interface{}{"type": "string", "enum": fields},
						"value": map[string]interface{}{"description": "The field value, matching the workflow schema."},
					},
					"required":             []string{"field", "value"},
					"additionalProperties": false,
				},
			}
		case "request_transition":
			tools[name] = protocol.ToolDef{
				Description: "Signal that this stage's work is complete; the workflow guard decides whether it advances.",
				InputSchema: map[string]interface{}{
					"type":                 "object",
					"properties":           map[string]interface{}{"reason": map[string]interface{}{"type": "string"}},
					"additionalProperties": false,
				},
			}
		case "append_note":
			tools[name] = protocol.ToolDef{
				Description: "Append an audit note to the task timeline.",
				InputSchema: map[string]interface{}{
					"type":                 "object",
					"properties":           map[string]interface{}{"text": map[string]interface{}{"type": "string"}},
					"required":             []string{"text"},
					"additionalProperties": false,
				},
			}
		case "block":
			tools[name] = protocol.ToolDef{
				Description: "Block the task when it cannot proceed without outside input.",
				InputSchema: map[string]interface{}{
					"type":                 "object",
					"properties":           map[string]interface{}{"reason": map[string]interface{}{"type": "string"}},
					"required":             []string{"reason"},
					"additionalProperties": false,
				},
			}
		case "cancel":
			tools[name] = protocol.ToolDef{
				Description: "Request cancellation for this task.",
				InputSchema: map[string]interface{}{
					"type":                 "object",
					"properties":           map[string]interface{}{"reason": map[string]interface{}{"type": "string"}},
					"additionalProperties": false,
				},
			}
		}
	}
	return tools
}

func allowedCommandTools(stage *workflow.StageDef) map[string]bool {
	allowed := make(map[string]bool)
	if stage == nil || len(stage.Tools) == 0 {
		for _, name := range supportedCommandTools {
			allowed[name] = true
		}
		return allowed
	}
	for _, name := range stage.Tools {
		for _, supported := range supportedCommandTools {
			if name == supported {
				allowed[name] = true
			}
		}
	}
	return allowed
}

func writableFieldNames(wf workflow.WorkflowDef, stage *workflow.StageDef) []string {
	if stage != nil && len(stage.OutputFields) > 0 {
		names := make([]string, 0, len(stage.OutputFields))
		for _, name := range stage.OutputFields {
			if _, ok := wf.Fields[name]; ok {
				names = append(names, name)
			}
		}
		sort.Strings(names)
		return names
	}
	return sortedFieldNames(wf.Fields)
}

func sortedFieldNames(fields map[string]workflow.FieldDef) []string {
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func sortedToolNames(tools map[string]protocol.ToolDef) []string {
	names := make([]string, 0, len(tools))
	for name := range tools {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func inlineTools(names []string) string {
	if len(names) == 0 {
		return "none"
	}
	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, "`"+name+"`")
	}
	return strings.Join(parts, ", ")
}
