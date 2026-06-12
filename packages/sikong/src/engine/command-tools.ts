import { defineTool, type ToolSet } from "agent-loop";
import type { Command, StageDef, WorkflowDef } from "../workflow/types";

/** The command tools a wake may expose. `create_subtask` is opt-in per stage. */
export const COMMAND_TOOL_NAMES = [
  "set_field",
  "request_transition",
  "append_note",
  "submit_evidence",
  "ack_lead_messages",
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
    name === "ack_lead_messages" ? true :
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

  if (on("submit_evidence"))
    tools.submit_evidence = defineTool({
      description:
        "Submit structured evidence for lead review. This records facts; it does not accept the work. A lead must review and accept/reject separately.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Short summary of the evidence and result." },
          checks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                command: { type: "string" },
                exitCode: { type: "number" },
                output: { type: "string" },
                path: { type: "string" },
                passed: { type: "boolean" },
              },
              required: ["label"],
              additionalProperties: false,
            },
          },
          changedFiles: {
            type: "array",
            items: { type: "string" },
          },
          artifacts: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      execute: (args) =>
        push({
          kind: "submit_evidence",
          evidence: {
            summary: String(args.summary),
            ...(Array.isArray(args.checks)
              ? {
                  checks: args.checks
                    .filter((check): check is Record<string, unknown> =>
                      typeof check === "object" && check !== null && !Array.isArray(check),
                    )
                    .map((check) => ({
                      label: String(check.label ?? ""),
                      ...(typeof check.command === "string" ? { command: check.command } : {}),
                      ...(typeof check.exitCode === "number" ? { exitCode: check.exitCode } : {}),
                      ...(typeof check.output === "string" ? { output: check.output } : {}),
                      ...(typeof check.path === "string" ? { path: check.path } : {}),
                      ...(typeof check.passed === "boolean" ? { passed: check.passed } : {}),
                    })),
                }
              : {}),
            ...(Array.isArray(args.changedFiles) ? { changedFiles: args.changedFiles.map(String) } : {}),
            ...(Array.isArray(args.artifacts) ? { artifacts: args.artifacts.map(String) } : {}),
          },
        }),
    });

  if (on("ack_lead_messages"))
    tools.ack_lead_messages = defineTool({
      description:
        "Acknowledge pending operator/lead messages before changing task topology. Use this to say whether you accept, reject, or defer the requested adjustment and what you will do next.",
      inputSchema: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Message ids being reviewed.",
          },
          decision: {
            type: "string",
            enum: ["accepted", "rejected", "deferred"],
          },
          response: {
            type: "string",
            description: "Lead decision and next action in plain language.",
          },
        },
        required: ["ids", "decision", "response"],
        additionalProperties: false,
      },
      execute: (args) =>
        push({
          kind: "ack_lead_messages",
          ids: Array.isArray(args.ids) ? args.ids.map(String) : [],
          decision: ["accepted", "rejected", "deferred"].includes(String(args.decision))
            ? (String(args.decision) as "accepted" | "rejected" | "deferred")
            : "deferred",
          response: String(args.response),
        }),
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
          key: {
            type: "string",
            description: "A short logical handle for this subtask (e.g. \"capture\"), referenced by other subtasks' dependsOn.",
          },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description:
              "Keys of subtasks (created in this same pass) that must finish before this one starts. Use it to order a layered effort instead of running everything in parallel.",
          },
          readScopes: {
            type: "array",
            items: { type: "string" },
            description:
              "Read scopes this child needs, e.g. package:packages/ui or file:README.md. Read/read scopes can overlap.",
          },
          writeScopes: {
            type: "array",
            items: { type: "string" },
            description:
              "Write scopes this child may change, e.g. file:packages/ui/src/Switch.tsx, package:packages/ui, api:ui-public-exports, or release:npm.",
          },
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "max"],
            description:
              "Reasoning-effort override for this subtask. Dial up for hard pieces (design/dialectic → high/max) or down for rote ones (plan/build/verify → low/medium). Defaults to the stage default or workspace default (medium).",
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
          ...(typeof args.key === "string" && args.key ? { key: args.key } : {}),
          ...(Array.isArray(args.dependsOn) && args.dependsOn.length
            ? { dependsOn: args.dependsOn.map(String) }
            : {}),
          ...(Array.isArray(args.readScopes) && args.readScopes.length
            ? { readScopes: args.readScopes.map(String) }
            : {}),
          ...(Array.isArray(args.writeScopes) && args.writeScopes.length
            ? { writeScopes: args.writeScopes.map(String) }
            : {}),
          ...(typeof args.effort === "string" && ["low", "medium", "high", "max"].includes(args.effort)
            ? { effort: args.effort as "low" | "medium" | "high" | "max" }
            : {}),
        }),
    });

  return { tools, drain: () => sink.splice(0) };
}
