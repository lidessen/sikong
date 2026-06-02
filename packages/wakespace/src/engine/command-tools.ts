import { defineTool, type ToolSet } from "agent-loop";
import type { Command, StageDef, WorkflowDef } from "../workflow/types";

/** The command tools a wake may expose. `create_subtask` is opt-in per stage. */
export const COMMAND_TOOL_NAMES = [
  "set_field",
  "request_transition",
  "append_note",
  "block",
  "cancel",
  "create_subtask",
] as const;

export type CommandToolName = (typeof COMMAND_TOOL_NAMES)[number];

/**
 * Build the agent-loop tools injected into a wake. Each tool's `execute` records
 * a `Command` into a sink (the reducer validates them after the run, like
 * exit-tools). A stage's `tools` allow-list gates which are exposed; when a stage
 * declares no `tools`, the full command set is available.
 */
export function buildCommandTools(
  wf: WorkflowDef,
  stage: StageDef | undefined,
  opts: { onCommand?: (command: Command) => void } = {},
): { tools: ToolSet; drain: () => Command[] } {
  const sink: Command[] = [];
  const push = (cmd: Command): { acknowledged: true } => {
    sink.push(cmd);
    opts.onCommand?.(cmd);
    return { acknowledged: true };
  };
  const allow = stage?.tools ? new Set(stage.tools) : null; // null ⇒ all defaults
  // `create_subtask` is a deliberate capability — opt-in only (a stage must list it).
  const on = (name: CommandToolName): boolean =>
    name === "create_subtask" ? (allow?.has(name) ?? false) : allow === null || allow.has(name);

  const fieldNames = (stage?.outputFields?.length ? stage.outputFields : Object.keys(wf.fields)).filter(
    (name) => wf.fields[name],
  );
  const tools: ToolSet = {};

  if (on("set_field"))
    tools.set_field = defineTool({
      description:
        "Set one of the task's fields. Fields are the task's durable state and how the workflow decides progress.",
      inputSchema: {
        type: "object",
        properties: {
          field: { type: "string", ...(fieldNames.length ? { enum: fieldNames } : {}) },
          value: { description: "The value, matching the field's declared type." },
        },
        required: ["field", "value"],
        additionalProperties: false,
      },
      execute: (args) => push({ kind: "set_field", field: String(args.field), value: args.value }),
    });

  if (on("request_transition"))
    tools.request_transition = defineTool({
      description:
        "Signal that this stage's work is complete. The workflow decides whether that admits the next stage — you do not transition directly.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        additionalProperties: false,
      },
      execute: (args) =>
        push({ kind: "request_transition", ...(args.reason ? { reason: String(args.reason) } : {}) }),
    });

  if (on("append_note"))
    tools.append_note = defineTool({
      description: "Append a note to the task's timeline (audit only; does not change state).",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      execute: (args) => push({ kind: "append_note", text: String(args.text) }),
    });

  if (on("block"))
    tools.block = defineTool({
      description: "Block the task when it cannot proceed without outside input. State why.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
        additionalProperties: false,
      },
      execute: (args) => push({ kind: "block", reason: String(args.reason) }),
    });

  if (on("cancel"))
    tools.cancel = defineTool({
      description:
        "Request cancellation when this task should not be done at all. Worker requests are audit-only until a lead approves cancellation.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        additionalProperties: false,
      },
      execute: (args) => push({ kind: "cancel", ...(args.reason ? { reason: String(args.reason) } : {}) }),
    });

  if (on("create_subtask"))
    tools.create_subtask = defineTool({
      description:
        "Spawn a child subtask on a registered workflow to handle part of this task. The child runs concurrently; gate a later stage on `childrenDone` to wait for all children to finish. (The engine assigns the child's id.)",
      inputSchema: {
        type: "object",
        properties: {
          workflowId: { type: "string", description: "a registered workflow id for the child" },
          input: { type: "string", description: "what the child should do" },
          isolate: {
            type: "boolean",
            description:
              "Run this child in an isolated workspace (its own git worktree, for git projects). Use it for parallel children that edit the same code; integrate their branches afterward.",
          },
        },
        required: ["workflowId", "input"],
        additionalProperties: false,
      },
      execute: (args) =>
        push({
          kind: "create_subtask",
          childId: "", // the engine mints it before recording the event
          workflowId: String(args.workflowId),
          input: String(args.input),
          ...(args.isolate === true ? { isolate: true } : {}),
        }),
    });

  return { tools, drain: () => sink.splice(0) };
}
