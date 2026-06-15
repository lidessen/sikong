import type { StageDef, TaskStatus, WorkflowDef, Task } from "../workflow/types";
import { COMMAND_TOOL_NAMES, type CommandToolName } from "./command-tools";
import type { LeadMessageKind } from "./steer-mailbox";
import { deriveLeadTeamStatus, type LeadStatusContext, type TeamMember } from "./team-status";

export interface ToolCallFact {
  tool: string;
  callId?: string;
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
}

export interface LeadMessageForPrompt {
  id: string;
  kind: LeadMessageKind;
  message: string;
  createdAt: number;
  source: string;
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
 * Assemble the wake's SYSTEM prompt — the STABLE half: role, stage instructions,
 * project memory, the field SCHEMA, and the tool lists. It is byte-stable across
 * a task's many re-wakes (within a stage), so DeepSeek's server-side prefix cache
 * covers it and re-wakes get ~10× cheaper. The VOLATILE half (current field
 * values + team snapshot) lives in the per-wake message (buildPrompt), and deeper
 * detail is pulled on demand by the agent's own tools.
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
): string {
  // STABLE PREFIX: workflow name + description always come first.
  // This section is byte-identical across ALL tasks of the same workflow+stage,
  // so DeepSeek's prefix cache covers it even across different tasks.
  const lines: string[] = [
    `# Workflow: ${wf.name}`,
    wf.description,
  ];
  if (stage?.instructions) lines.push("", "## Stage", stage.instructions);
  if (projectMemory.trim()) lines.push("", "## Project memory", projectMemory.trim());

  // Schema — also stable (schema is defined by the workflow, not per-task)
  const fieldNames = Object.keys(wf.fields);
  if (fieldNames.length) {
    lines.push("", "## Fields (the task's state — schema; current values are in the wake message)");
    for (const name of fieldNames) {
      const def = wf.fields[name];
      lines.push(`- ${name} (${def?.type})${def?.description ? ` — ${def.description}` : ""}`);
    }
  }

  // Tool lists — stable per stage
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

  // VOLATILE TAIL: task identity line (changes per wake for different tasks).
  // Placed at the end so the prefix cache covers the stable sections above
  // across the widest possible set of wakes.
  lines.push("", `## Task identity`, `You are advancing task ${task.id} (depth ${task.depth}${task.parentId ? `, child of ${task.parentId}` : ""}), currently in stage "${task.stageId}"${stage ? ` (${stage.category})` : ""}.`);

  return lines.join("\n");
}

/**
 * The per-wake message: the VOLATILE state — current field values + the team
 * snapshot — plus the action nudge. Kept out of the system prompt so the system
 * stays prefix-stable (cacheable). The agent is told to pull deeper detail
 * (full subtask output, files) on demand with its own tools rather than have it
 * all pre-stuffed here.
 */
export function buildPrompt(
  task: Task,
  wf: WorkflowDef,
  stage: StageDef | undefined,
  team: readonly TeamMember[] = [],
  status: LeadStatusContext = {},
  leadMessages: readonly LeadMessageForPrompt[] = [],
): string {
  const lines: string[] = [];
  const fieldNames = Object.keys(wf.fields);
  if (fieldNames.length) {
    lines.push("## Current field values");
    for (const name of fieldNames) {
      lines.push(`- ${name}: ${renderValue(task.fields[name])}`);
    }
  }
  const transitionRequested = Boolean(status.eventTypes?.has("transition.requested"));
  const acceptanceStatus = status.acceptanceStatus ?? "none";
  lines.push(
    "",
    "## Task status",
    `- current stage: ${task.stageId}; transition requested: ${transitionRequested ? "yes" : "no"}; acceptance: ${acceptanceStatus}`,
  );
  if (status.acceptanceReason) lines.push(`- latest acceptance reason: ${status.acceptanceReason}`);
  if (leadMessages.length) {
    lines.push(
      "",
      "## Pending operator messages",
      "These messages are control intent for the lead. Review them before changing task topology. If you accept, reject, or defer them, call `ack_lead_messages` with the message ids and your decision before creating subtasks.",
    );
    for (const msg of leadMessages) {
      lines.push(
        `- ${msg.id} (${msg.kind}, ${new Date(msg.createdAt).toISOString()}, ${msg.source}): ${renderValue(msg.message)}`,
      );
    }
  }
  if (team.length) {
    const digest = deriveLeadTeamStatus(task, stage, team, status);
    lines.push(
      "",
      "## Lead team status",
      `- classification: ${digest.classification}`,
      `- children: total=${digest.total} done=${digest.done} cancelled=${digest.cancelled} active=${digest.active}`,
      `- current stage: ${task.stageId}; transition requested: ${digest.transitionRequested ? "yes" : "no"}; acceptance: ${digest.acceptanceStatus}`,
      ...(digest.acceptanceReason ? [`- latest acceptance reason: ${digest.acceptanceReason}`] : []),
      `- next: ${digest.next}`,
    );
    lines.push("", "## Team (your subtasks)");
    for (const m of team) {
      const parts = [`- ${m.id} (${m.workflowId}${m.stageId ? `@${m.stageId}` : ""}) — ${m.status}`];
      if (m.isolate) parts.push(`[isolated → branch sikong/${m.id}]`);
      if (m.summary) parts.push(`summary: ${renderValue(m.summary)}`);
      else if (m.request) parts.push(`request: ${renderValue(m.request)}`);
      lines.push(parts.join("  "));
    }
    lines.push(
      "Review what your subtasks returned (read a subtask's full output or the project files with your tools if you need more than the summary). To take it further, create more subtasks or finish this stage — never reach into a running subtask.",
    );
  }
  lines.push("", `Advance task ${task.id} now: do this stage's work and update the task via the tools.`);
  return lines.join("\n");
}
