import { defineTool, type ToolSet } from "agent-loop";
import {
  addWorkspacePreference,
  createTask,
  createWorkspace,
  fail,
  getTask,
  getWorkspace,
  inspectTaskCompact,
  inspectTaskEvents,
  inspectTaskProjection,
  inspectTaskSummary,
  inspectTaskTrace,
  listTasks,
  listWorkspacePreferences,
  listWorkspaces,
  removeWorkspacePreference,
  waitTask,
  type CommandContext,
  type CommandResult,
} from "../commands";
import type { ClientTranscriptSource } from "../client-agent/context";
import { parseClientTurnOutcome, type ClientTurnOutcomeSink } from "../client-agent/outcome";

export interface ClientAgentToolsOptions {
  ctx: CommandContext;
  transcript?: ClientTranscriptSource;
  mode?: "work" | "settlement";
  outcome?: ClientTurnOutcomeSink;
  onFinish?: () => void;
}

export function createClientAgentTools(options: ClientAgentToolsOptions): ToolSet {
  const { ctx, transcript } = options;
  const mode = options.mode ?? "work";
  const tools: ToolSet = {
    listTranscriptRecent: defineTool({
      description: "List recent UI transcript messages for conversation continuity.",
      inputSchema: objectSchema({ limit: numberSchema() }),
      execute: async (args) =>
        await transcriptResult(
          transcript?.listRecent({ limit: optionalNumber(args, "limit") }) ?? Promise.resolve([]),
        ),
    }),
    searchTranscript: defineTool({
      description: "Search UI transcript messages when prior conversation matters.",
      inputSchema: objectSchema(
        {
          query: stringSchema(),
          limit: numberSchema(),
        },
        ["query"],
      ),
      execute: async (args) => {
        const query = requiredString(args, "query");
        if (!query.ok) return query;
        return await transcriptResult(
          transcript?.search({ query: query.data, limit: optionalNumber(args, "limit") }) ??
            Promise.resolve([]),
        );
      },
    }),
    getTranscriptRange: defineTool({
      description: "Read a transcript range before a message id.",
      inputSchema: objectSchema({
        beforeMessageId: stringSchema(),
        limit: numberSchema(),
      }),
      execute: async (args) =>
        await transcriptResult(
          transcript?.getRange({
            beforeMessageId: optionalString(args, "beforeMessageId"),
            limit: optionalNumber(args, "limit"),
          }) ?? Promise.resolve([]),
        ),
    }),
    listWorkspaces: defineTool({
      description: "List Sikong workspaces.",
      inputSchema: objectSchema({}),
      execute: async () => await listWorkspaces(ctx),
    }),
    getWorkspace: defineTool({
      description: "Read one Sikong workspace.",
      inputSchema: objectSchema({ workspaceId: stringSchema() }, ["workspaceId"]),
      execute: async (args) => {
        const workspaceId = requiredString(args, "workspaceId");
        if (!workspaceId.ok) return workspaceId;
        return await getWorkspace(ctx, { workspaceId: workspaceId.data });
      },
    }),
    getWorkspaceSource: defineTool({
      description:
        "Read authoritative workspace source records: workspace, preferences, and task cards.",
      inputSchema: objectSchema({ workspaceId: stringSchema() }, ["workspaceId"]),
      execute: async (args) => {
        const workspaceId = requiredString(args, "workspaceId");
        if (!workspaceId.ok) return workspaceId;
        const [workspace, preferences, tasks] = await Promise.all([
          getWorkspace(ctx, { workspaceId: workspaceId.data }),
          listWorkspacePreferences(ctx, { workspaceId: workspaceId.data }),
          listTasks(ctx, { workspaceId: workspaceId.data }),
        ]);
        if (!workspace.ok) return workspace;
        if (!preferences.ok) return preferences;
        if (!tasks.ok) return tasks;
        return {
          ok: true,
          data: {
            workspace: workspace.data.workspace,
            preferences: preferences.data.preferences,
            taskCards: tasks.data.tasks,
          },
        };
      },
    }),
    listWorkspacePreferences: defineTool({
      description: "List workspace preferences.",
      inputSchema: objectSchema({ workspaceId: stringSchema() }),
      execute: async (args) =>
        await listWorkspacePreferences(ctx, { workspaceId: optionalString(args, "workspaceId") }),
    }),
    getTask: defineTool({
      description: "Read one Sikong task projection.",
      inputSchema: taskIdSchema,
      execute: async (args) => {
        const input = taskInput(args);
        if (!input.ok) return input;
        return await getTask(ctx, input.data);
      },
    }),
    listTasks: defineTool({
      description: "List compact Sikong task cards for a workspace.",
      inputSchema: objectSchema({ workspaceId: stringSchema() }),
      execute: async (args) =>
        await listTasks(ctx, { workspaceId: optionalString(args, "workspaceId") }),
    }),
    inspectTaskSummary: defineTool({
      description: "Read a compact Sikong task summary.",
      inputSchema: taskIdSchema,
      execute: async (args) => {
        const input = taskInput(args);
        if (!input.ok) return input;
        return await inspectTaskSummary(ctx, input.data);
      },
    }),
    inspectTaskCompact: defineTool({
      description: "Read the compact Sikong task view with next action.",
      inputSchema: taskIdSchema,
      execute: async (args) => {
        const input = taskInput(args);
        if (!input.ok) return input;
        return await inspectTaskCompact(ctx, input.data);
      },
    }),
    inspectTaskTrace: defineTool({
      description: "Read a summarized Sikong task event trace.",
      inputSchema: objectSchema(
        {
          workspaceId: stringSchema(),
          taskId: stringSchema(),
          follow: booleanSchema(),
        },
        ["taskId"],
      ),
      execute: async (args) => {
        const input = taskInput(args);
        if (!input.ok) return input;
        return await inspectTaskTrace(ctx, {
          ...input.data,
          follow: optionalBoolean(args, "follow"),
        });
      },
    }),
    inspectTaskEvents: defineTool({
      description: "Read raw Sikong task events.",
      inputSchema: taskIdSchema,
      execute: async (args) => {
        const input = taskInput(args);
        if (!input.ok) return input;
        return await inspectTaskEvents(ctx, input.data);
      },
    }),
    inspectTaskProjection: defineTool({
      description: "Read the full Sikong task projection.",
      inputSchema: taskIdSchema,
      execute: async (args) => {
        const input = taskInput(args);
        if (!input.ok) return input;
        return await inspectTaskProjection(ctx, input.data);
      },
    }),
  };

  if (options.outcome) {
    tools.finishClientTurn = defineTool({
      description:
        "Finish this client-agent turn with a structured report, question, or user request.",
      inputSchema: clientTurnOutcomeSchema,
      execute: async (args, toolCtx) => {
        const parsed = parseClientTurnOutcome(args);
        if (!parsed.ok) return parsed;
        options.outcome!.outcome ??= parsed.data;
        toolCtx.requestStop?.("client-agent turn outcome submitted");
        options.onFinish?.();
        return { ok: true, data: { outcome: options.outcome!.outcome } };
      },
    });
  }

  if (mode === "settlement") return tools;

  Object.assign(tools, {
    createWorkspace: defineTool({
      description: "Create a Sikong workspace.",
      inputSchema: objectSchema(
        {
          id: stringSchema(),
          name: stringSchema(),
        },
        ["id", "name"],
      ),
      execute: async (args) => {
        const id = requiredString(args, "id");
        if (!id.ok) return id;
        const name = requiredString(args, "name");
        if (!name.ok) return name;
        return await createWorkspace(ctx, { id: id.data, name: name.data });
      },
    }),
    addWorkspacePreference: defineTool({
      description: "Add a workspace preference.",
      inputSchema: objectSchema(
        {
          workspaceId: stringSchema(),
          text: stringSchema(),
          note: stringSchema(),
        },
        ["text"],
      ),
      execute: async (args) => {
        const text = requiredString(args, "text");
        if (!text.ok) return text;
        return await addWorkspacePreference(ctx, {
          workspaceId: optionalString(args, "workspaceId"),
          text: text.data,
          note: optionalString(args, "note"),
        });
      },
    }),
    removeWorkspacePreference: defineTool({
      description: "Remove a workspace preference.",
      inputSchema: objectSchema(
        {
          workspaceId: stringSchema(),
          preferenceId: stringSchema(),
        },
        ["preferenceId"],
      ),
      execute: async (args) => {
        const preferenceId = requiredString(args, "preferenceId");
        if (!preferenceId.ok) return preferenceId;
        return await removeWorkspacePreference(ctx, {
          workspaceId: optionalString(args, "workspaceId"),
          preferenceId: preferenceId.data,
        });
      },
    }),
    createTask: defineTool({
      description: "Create a durable Sikong task.",
      inputSchema: objectSchema(
        {
          workspaceId: stringSchema(),
          request: stringSchema(),
        },
        ["request"],
      ),
      execute: async (args) => {
        const request = requiredString(args, "request");
        if (!request.ok) return request;
        return await createTask(ctx, {
          workspaceId: optionalString(args, "workspaceId"),
          request: request.data,
        });
      },
    }),
    waitTask: defineTool({
      description: "Wait until a Sikong task reaches a caller-visible boundary.",
      inputSchema: objectSchema(
        {
          workspaceId: stringSchema(),
          taskId: stringSchema(),
          timeoutMs: numberSchema(),
          intervalMs: numberSchema(),
        },
        ["taskId"],
      ),
      execute: async (args) => {
        const input = taskInput(args);
        if (!input.ok) return input;
        return await waitTask(ctx, {
          ...input.data,
          timeoutMs: optionalNumber(args, "timeoutMs"),
          intervalMs: optionalNumber(args, "intervalMs"),
        });
      },
    }),
  });

  return tools;
}

async function transcriptResult(messages: Promise<unknown[]>): Promise<CommandResult<unknown[]>> {
  return { ok: true, data: await messages };
}

const taskIdSchema = objectSchema(
  {
    workspaceId: stringSchema(),
    taskId: stringSchema(),
  },
  ["taskId"],
);

const clientTurnRefsSchema = arraySchema(
  objectSchema(
    {
      type: enumSchema(["workspace", "task", "transcript", "other"]),
      id: stringSchema(),
    },
    ["type", "id"],
  ),
);

const clientTurnOutcomeSchema: Record<string, unknown> = {
  type: "object",
  oneOf: [
    objectSchema(
      {
        kind: constSchema("report"),
        title: stringSchema("Short report title."),
        summary: stringSchema("User-visible Markdown summary."),
        facts: arraySchema(
          objectSchema(
            {
              label: stringSchema(),
              value: stringSchema(),
            },
            ["label", "value"],
          ),
        ),
        refs: clientTurnRefsSchema,
      },
      ["kind", "title", "summary"],
    ),
    objectSchema(
      {
        kind: constSchema("question"),
        question: stringSchema("The question that needs the user's answer."),
        context: stringSchema("Brief factual context for why the question is needed."),
        options: arraySchema(stringSchema()),
        refs: clientTurnRefsSchema,
      },
      ["kind", "question"],
    ),
    objectSchema(
      {
        kind: constSchema("request"),
        requestType: enumSchema([
          "plan_decision",
          "final_decision",
          "permission",
          "clarification",
          "other",
        ]),
        title: stringSchema("Short request title."),
        body: stringSchema("User-visible Markdown request body."),
        target: objectSchema({
          workspaceId: stringSchema(),
          taskId: stringSchema(),
          planId: stringSchema(),
          version: numberSchema(),
        }),
        refs: clientTurnRefsSchema,
      },
      ["kind", "requestType", "title", "body"],
    ),
  ],
};

function taskInput(
  args: Record<string, unknown>,
): CommandResult<{ workspaceId?: string; taskId: string }> {
  const taskId = requiredString(args, "taskId");
  if (!taskId.ok) return taskId;
  return {
    ok: true,
    data: {
      workspaceId: optionalString(args, "workspaceId"),
      taskId: taskId.data,
    },
  };
}

function requiredString(args: Record<string, unknown>, key: string): CommandResult<string> {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    return fail("invalid_input", `${key} must be a non-empty string.`);
  }
  return { ok: true, data: value };
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === "boolean" ? args[key] : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  return typeof args[key] === "number" ? args[key] : undefined;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function stringSchema(description?: string): Record<string, unknown> {
  return { type: "string", ...(description ? { description } : {}) };
}

function booleanSchema(): Record<string, unknown> {
  return { type: "boolean" };
}

function numberSchema(): Record<string, unknown> {
  return { type: "number" };
}

function enumSchema(values: string[]): Record<string, unknown> {
  return { type: "string", enum: values };
}

function constSchema(value: string): Record<string, unknown> {
  return { type: "string", const: value };
}

function arraySchema(items: Record<string, unknown>): Record<string, unknown> {
  return { type: "array", items };
}
