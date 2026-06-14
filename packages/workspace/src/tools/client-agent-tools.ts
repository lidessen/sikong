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

export interface ClientAgentToolsOptions {
  ctx: CommandContext;
}

export function createClientAgentTools(options: ClientAgentToolsOptions): ToolSet {
  const { ctx } = options;
  return {
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
    listWorkspacePreferences: defineTool({
      description: "List workspace preferences.",
      inputSchema: objectSchema({ workspaceId: stringSchema() }),
      execute: async (args) =>
        await listWorkspacePreferences(ctx, { workspaceId: optionalString(args, "workspaceId") }),
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
          cwd: stringSchema(),
          repoPath: stringSchema(),
        },
        ["request"],
      ),
      execute: async (args) => {
        const request = requiredString(args, "request");
        if (!request.ok) return request;
        return await createTask(ctx, {
          workspaceId: optionalString(args, "workspaceId"),
          request: request.data,
          cwd: optionalString(args, "cwd"),
          repoPath: optionalString(args, "repoPath"),
        });
      },
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
  };
}

const taskIdSchema = objectSchema(
  {
    workspaceId: stringSchema(),
    taskId: stringSchema(),
  },
  ["taskId"],
);

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

function stringSchema(): Record<string, unknown> {
  return { type: "string" };
}

function booleanSchema(): Record<string, unknown> {
  return { type: "boolean" };
}

function numberSchema(): Record<string, unknown> {
  return { type: "number" };
}
