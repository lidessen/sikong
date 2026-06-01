import type { StageDef, WorkflowDef, Task } from "../workflow/types";
import { COMMAND_TOOL_NAMES, type CommandToolName } from "./command-tools";

export interface ToolCallFact {
  tool: string;
  callId?: string;
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
}

export interface CommitEvidence {
  projectToolCalls: number;
  projectWriteCalls: number;
  projectWriteRequired: boolean;
  failedProjectCommandCalls?: number;
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
 */
export function buildSystem(
  task: Task,
  wf: WorkflowDef,
  stage: StageDef | undefined,
  projectToolNames: readonly string[] = [],
  projectMemory = "",
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

  const toolNames = stageToolNames(stage);
  lines.push(
    "",
    "## How to make progress",
    `Tools available this stage: ${toolNames.map((n) => `\`${n}\``).join(", ")}.`,
    "Update the task's state with these tools. When this stage's work is done, call `request_transition`. You cannot transition or complete the task directly — the workflow decides when it advances based on its guards, so make sure the fields they read are set first.",
  );
  if (projectToolNames.length) {
    lines.push(
      "",
      "## Project tools",
      `Project tools available to this worker: ${projectToolNames.map((n) => `\`${n}\``).join(", ")}.`,
      "Use them to inspect and edit the project, search code, and fetch web context when the stage requires it. Prefer `rg` for finding symbols and `viewFile` for line-numbered file windows; use raw `readFile` only when the whole file is needed. Local project tools are scoped to the project root. They do not replace the workflow state tools; record durable progress with the stage tools above.",
    );
    if (stage?.id === "verify" && projectToolNames.includes("runHostCheck")) {
      lines.push(
        "For deterministic verification, prefer `runHostCheck` over sandboxed `bash`; it runs approved checks against the real host project checkout and returns exit code plus bounded stdout/stderr.",
      );
    }
    if (stage?.requiresProjectWrite) {
      lines.push(
        "This stage requires a successful structured project write through `replaceInFile` or `writeFile` before normal stage progress can be committed. Raw shell access may be reserved for non-write stages such as verification. Gather the context you need, then edit; do not end the wake after inspection only. If no edit should be made, call `block` with the concrete reason before returning.",
      );
    }
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
  evidence: CommitEvidence,
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
    "The previous worker pass ended without calling any wakespace state tool.",
    `Project tool calls observed in that pass: ${evidence.projectToolCalls}.`,
    `Project write tool calls observed in that pass: ${evidence.projectWriteCalls}.`,
    `Failed project verification commands observed in that pass: ${evidence.failedProjectCommandCalls ?? 0}.`,
    stage?.outputFields?.length ? `Stage output fields: ${stage.outputFields.join(", ")}.` : "Stage output fields: unrestricted by stage.",
    "You must now call at least one provided state tool. Do not answer in plain text.",
    stage?.id === "verify" && (evidence.failedProjectCommandCalls ?? 0) > 0
      ? "Verification observed failed project commands. Do not mark verification complete; call `block` with the concrete failed command evidence."
      : evidence.projectWriteRequired && evidence.projectWriteCalls === 0
        ? "This stage requires project write evidence, but no project write tool call was observed. Do not mark the stage complete or request cancellation; call `block` with a concrete reason."
        : "Use the provided workflow state tools to set the fields this stage requires, then call `request_transition` if this stage is complete.",
    "If the task cannot be completed, call `block` with a concrete reason.",
  ];
  if (evidence.toolCallFacts?.length) {
    lines.push(
      "",
      "## Observed tool facts",
      "These compact sanitized previews are the facts from the previous worker pass. Base durable verification or implementation claims on them; block if the facts are insufficient.",
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
