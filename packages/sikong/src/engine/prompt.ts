import type { StageDef, TaskStatus, WorkflowDef, Task } from "../workflow/types";
import { COMMAND_TOOL_NAMES, type CommandToolName } from "./command-tools";

/** A compact, read-only snapshot of a child task shown to its lead's wake (ADR 0009). */
export interface TeamMember {
  id: string;
  workflowId: string;
  status: TaskStatus;
  /** Ran in an isolated workspace (its work is on branch `sikong/<id>` for git projects). */
  isolate?: boolean;
  summary?: string;
  request?: string;
}

export interface ToolCallFact {
  tool: string;
  callId?: string;
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
}

/** Facts carried from the worker pass into the commit fallback (task-agnostic). */
export interface CommitEvidence {
  toolCallFacts?: readonly ToolCallFact[];
}

function stageToolNames(stage: StageDef | undefined): readonly CommandToolName[] {
  if (!stage?.tools) return COMMAND_TOOL_NAMES;
  return COMMAND_TOOL_NAMES.filter((n) => stage.tools!.includes(n));
}

/** Render a field value compactly, eliding large JSON so it can't bloat context. */
function renderValue(value: unknown): string {
  if (value === undefined) return "(unset)";
  const s = JSON.stringify(value);
  return s.length > 200 ? `${s.slice(0, 200)}… (${s.length} chars)` : s;
}

/**
 * Assemble the wake's system prompt from the PROJECTION (fields), never the raw
 * timeline — the projection is the snapshot an agent reads (event-sourcing /
 * context-rot discipline). M1 keeps this minimal; richer context (a rolling
 * timeline summary, retrieval tool) is a later refinement.
 *
 * Task-agnostic by design: it renders state and lists the worker's tools, but it
 * never teaches the worker HOW to do the work — that is the agent's own concern.
 */
export function buildSystem(
  task: Task,
  wf: WorkflowDef,
  stage: StageDef | undefined,
  workerToolNames: readonly string[] = [],
  projectMemory = "",
  team: readonly TeamMember[] = [],
): string {
  const lines: string[] = [
    `# Workflow: ${wf.name}`,
    wf.description,
    "",
    `You are advancing task ${task.id}, currently in stage "${task.stageId}"${
      stage ? ` (${stage.category})` : ""
    }.`,
  ];
  if (stage?.instructions) lines.push("", "## Stage", stage.instructions);
  if (projectMemory.trim()) lines.push("", "## Project memory", projectMemory.trim());

  const fieldNames = Object.keys(wf.fields);
  if (fieldNames.length) {
    lines.push("", "## Fields (the task's state)");
    for (const name of fieldNames) {
      const def = wf.fields[name];
      lines.push(
        `- ${name} (${def?.type})${def?.description ? ` — ${def.description}` : ""}: ${renderValue(task.fields[name])}`,
      );
    }
  }

  if (team.length) {
    lines.push("", "## Team (your subtasks)");
    for (const m of team) {
      const parts = [`- ${m.id} (${m.workflowId}) — ${m.status}`];
      if (m.isolate) parts.push(`[isolated → branch sikong/${m.id}]`);
      if (m.summary) parts.push(`summary: ${renderValue(m.summary)}`);
      else if (m.request) parts.push(`request: ${renderValue(m.request)}`);
      lines.push(parts.join("  "));
    }
    lines.push(
      "Review what your subtasks returned. To take it further, create more subtasks or finish this stage — never reach into a running subtask.",
    );
  }

  const toolNames = stageToolNames(stage);
  lines.push(
    "",
    "## How to make progress",
    `Tools available this stage: ${toolNames.map((n) => `\`${n}\``).join(", ")}.`,
    "Update the task's state with these tools. When this stage's work is done, call `request_transition`. You cannot transition or complete the task directly — the workflow decides when it advances based on its guards, so make sure the fields they read are set first.",
  );
  if (workerToolNames.length) {
    lines.push(
      "",
      "## Worker tools",
      `Tools your worker brings to this wake: ${workerToolNames.map((n) => `\`${n}\``).join(", ")}.`,
      "Use them to do the stage's actual work. They do not replace the workflow state tools — record durable progress with the stage tools above.",
    );
  }
  return lines.join("\n");
}

export function buildPrompt(task: Task, wf: WorkflowDef, stage: StageDef | undefined): string {
  void wf;
  void stage;
  return `Advance task ${task.id} now: do this stage's work and update the task via the tools.`;
}

export function buildCommitSystem(
  task: Task,
  wf: WorkflowDef,
  stage: StageDef | undefined,
  priorText: string,
  evidence: CommitEvidence = {},
): string {
  const lines = [
    `# Workflow: ${wf.name}`,
    "",
    `You are committing durable progress for task ${task.id}.`,
    `Current stage: ${task.stageId}${stage?.instructions ? ` — ${stage.instructions}` : ""}`,
    "",
    "## Current task fields",
    ...Object.keys(wf.fields).map((name) => {
      const def = wf.fields[name];
      return `- ${name} (${def?.type})${def?.description ? ` — ${def.description}` : ""}: ${renderValue(task.fields[name])}`;
    }),
    "",
    "The previous worker pass ended without recording any durable sikong state.",
    stage?.outputFields?.length ? `Stage output fields: ${stage.outputFields.join(", ")}.` : "Stage output fields: unrestricted by stage.",
    "You must now call at least one provided state tool. Do not answer in plain text.",
    "Use `commit_stage` to set the fields this stage requires and request transition if the stage is complete. If the task cannot be completed, call `block` with a concrete reason.",
  ];
  if (evidence.toolCallFacts?.length) {
    lines.push(
      "",
      "## Observed tool facts",
      "These compact sanitized previews are the facts from the previous worker pass. Base your durable summary on them; block if the facts are insufficient.",
      ...evidence.toolCallFacts.map((fact) => {
        const parts = [`- ${fact.tool}`];
        if (fact.callId) parts.push(`[${fact.callId}]`);
        if (fact.argsPreview) parts.push(`args=${fact.argsPreview}`);
        if (fact.resultPreview) parts.push(`result=${fact.resultPreview}`);
        if (fact.error) parts.push(`error=${fact.error}`);
        return parts.join(" ");
      }),
    );
  }
  if (priorText.trim()) lines.push("", "## Previous worker text", priorText.trim());
  return lines.join("\n");
}
