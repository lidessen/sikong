import { describe, expect, test } from "bun:test";
import type { ToolDefinition, ToolSet } from "agent-loop";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../commands";
import { createClientAgentTools } from "./client-agent-tools";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-client-tools-"));

function ctx(dataDir: string): CommandContext {
  let id = 0;
  return {
    dataDir,
    workspaceId: "sikong",
    now: () => new Date("2026-06-14T00:00:00.000Z"),
    id: () => `id_${++id}`,
  };
}

async function callTool(
  tools: ToolSet,
  name: string,
  args: Record<string, unknown> = {},
  toolCtx: Parameters<NonNullable<ToolDefinition["execute"]>>[1] = {},
) {
  const tool = requireTool(tools, name);
  if (!tool.execute) throw new Error(`missing execute: ${name}`);
  return await tool.execute(args, toolCtx);
}

function requireTool(tools: ToolSet, name: string): ToolDefinition {
  const tool = tools[name];
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

describe("client agent tools", () => {
  test("declare required inputs in tool schemas", () => {
    const tools = createClientAgentTools({ ctx: ctx("/tmp/sikong-client-tools-test") });

    expect(schemaRequired(requireTool(tools, "createWorkspace").inputSchema)).toEqual([
      "id",
      "name",
    ]);
    expect(schemaRequired(requireTool(tools, "addWorkspacePreference").inputSchema)).toEqual([
      "text",
    ]);
    expect(schemaRequired(requireTool(tools, "createTask").inputSchema)).toEqual(["request"]);
    expect(tools.driveTask).toBeUndefined();
    expect(schemaRequired(requireTool(tools, "searchTranscript").inputSchema)).toEqual(["query"]);
    expect(schemaRequired(requireTool(tools, "getWorkspaceSource").inputSchema)).toEqual([
      "workspaceId",
    ]);
    expect(schemaRequired(requireTool(tools, "inspectTaskCompact").inputSchema)).toEqual([
      "taskId",
    ]);
  });

  test("settlement tools are read-only and can finish the turn", async () => {
    const sink = {};
    let finished = false;
    let stopReason: string | undefined;
    const tools = createClientAgentTools({
      ctx: ctx("/tmp/sikong-client-tools-test"),
      mode: "settlement",
      outcome: sink,
      onFinish: () => {
        finished = true;
      },
    });

    expect(tools.listWorkspaces).toBeDefined();
    expect(tools.getWorkspaceSource).toBeDefined();
    expect(tools.inspectTaskCompact).toBeDefined();
    expect(tools.createWorkspace).toBeUndefined();
    expect(tools.createTask).toBeUndefined();
    expect(tools.addWorkspacePreference).toBeUndefined();
    expect(tools.removeWorkspacePreference).toBeUndefined();
    expect(tools.waitTask).toBeUndefined();

    expect(
      await callTool(
        tools,
        "finishClientTurn",
        {
          kind: "report",
          title: "Done",
          summary: "Created the requested workspace.",
          facts: [{ label: "workspace", value: "sikong" }],
        },
        {
          requestStop: (reason) => {
            stopReason = reason;
          },
        },
      ),
    ).toMatchObject({
      ok: true,
      data: {
        outcome: {
          kind: "report",
          title: "Done",
          summary: "Created the requested workspace.",
        },
      },
    });
    expect(finished).toBe(true);
    expect(sink).toMatchObject({
      outcome: {
        kind: "report",
        title: "Done",
      },
    });
    expect(stopReason).toBe("client-agent turn outcome submitted");
  });

  test("finishClientTurn schema declares variant-specific required fields", () => {
    const tools = createClientAgentTools({
      ctx: ctx("/tmp/sikong-client-tools-test"),
      mode: "settlement",
      outcome: {},
    });
    const schema = requireTool(tools, "finishClientTurn").inputSchema as {
      oneOf?: Array<{ required?: string[] }>;
    };

    expect(schema.oneOf?.map((variant) => variant.required)).toEqual([
      ["kind", "title", "summary"],
      ["kind", "question"],
      ["kind", "requestType", "title", "body"],
    ]);
  });

  test("expose transcript, workspace, preference, task, and inspect command handlers", async () => {
    const dir = await tmp();
    try {
      const tools = createClientAgentTools({
        ctx: ctx(dir),
        transcript: {
          listRecent: async () => [
            {
              id: "m1",
              role: "user",
              createdAt: "2026-06-14T00:00:00.000Z",
              parts: [{ type: "text", text: "Create a Sikong workspace." }],
            },
          ],
          search: async ({ query }) =>
            query === "workspace"
              ? [
                  {
                    id: "m1",
                    role: "user",
                    createdAt: "2026-06-14T00:00:00.000Z",
                    parts: [{ type: "text", text: "Create a Sikong workspace." }],
                  },
                ]
              : [],
          getRange: async () => [],
        },
      });

      expect(await callTool(tools, "listTranscriptRecent")).toMatchObject({
        ok: true,
        data: [{ id: "m1", role: "user" }],
      });
      expect(await callTool(tools, "searchTranscript", { query: "workspace" })).toMatchObject({
        ok: true,
        data: [{ id: "m1", role: "user" }],
      });

      expect(await callTool(tools, "createWorkspace", { id: "sikong", name: "Sikong" })).toEqual({
        ok: true,
        data: { workspace: { id: "sikong", name: "Sikong" } },
      });
      expect(await callTool(tools, "listWorkspaces")).toMatchObject({
        ok: true,
        data: { workspaces: [{ id: "sikong", name: "Sikong" }] },
      });
      expect(await callTool(tools, "getWorkspace", { workspaceId: "sikong" })).toMatchObject({
        ok: true,
        data: { workspace: { id: "sikong" } },
      });

      const addedPreference = await callTool(tools, "addWorkspacePreference", {
        workspaceId: "sikong",
        text: "Run bun run check before handoff.",
      });
      expect(addedPreference).toMatchObject({
        ok: true,
        data: { preference: { id: "run-bun-run-check" } },
      });
      expect(await callTool(tools, "listWorkspacePreferences", { workspaceId: "sikong" })).toEqual({
        ok: true,
        data: {
          preferences: [
            {
              id: "run-bun-run-check",
              text: "Run bun run check before handoff.",
            },
          ],
        },
      });

      const createdTask = await callTool(tools, "createTask", {
        workspaceId: "sikong",
        request: "Implement client agent tools.",
      });
      expect(createdTask).toMatchObject({
        ok: true,
        data: {
          taskId: "task_id_1",
          projection: {
            taskId: "task_id_1",
            status: "created",
            runtime: {
              cwd: join(dir, "workspaces", "sikong", "tasks", "task_id_1"),
            },
          },
        },
      });
      const createdTaskResult = createdTask as
        | { ok: true; data: { taskId: string } }
        | { ok: false };
      if (!createdTaskResult.ok) {
        throw new Error("task create failed");
      }
      const taskId = createdTaskResult.data.taskId;

      expect(await callTool(tools, "getWorkspaceSource", { workspaceId: "sikong" })).toMatchObject({
        ok: true,
        data: {
          workspace: { id: "sikong" },
          preferences: [{ id: "run-bun-run-check" }],
          taskCards: [{ taskId, status: "created" }],
        },
      });

      expect(await callTool(tools, "getTask", { workspaceId: "sikong", taskId })).toMatchObject({
        ok: true,
        data: { projection: { taskId, status: "created" } },
      });
      expect(await callTool(tools, "listTasks", { workspaceId: "sikong" })).toMatchObject({
        ok: true,
        data: { tasks: [{ taskId, status: "created" }] },
      });
      expect(
        await callTool(tools, "inspectTaskSummary", { workspaceId: "sikong", taskId }),
      ).toMatchObject({
        ok: true,
        data: {
          summary: {
            taskId,
            status: "created",
          },
        },
      });
      expect(
        await callTool(tools, "inspectTaskCompact", { workspaceId: "sikong", taskId }),
      ).toMatchObject({
        ok: true,
        data: {
          compact: {
            taskId,
            nextAction: { type: "start_lead_requirement_spec" },
            runtimeProcesses: { total: 0, running: 0 },
          },
        },
      });
      expect(
        await callTool(tools, "inspectTaskTrace", { workspaceId: "sikong", taskId }),
      ).toMatchObject({
        ok: true,
        data: {
          trace: [{ type: "task.created", summary: "Implement client agent tools." }],
        },
      });
      expect(
        await callTool(tools, "inspectTaskEvents", { workspaceId: "sikong", taskId }),
      ).toMatchObject({
        ok: true,
        data: { events: [{ type: "task.created" }] },
      });
      expect(
        await callTool(tools, "inspectTaskProjection", { workspaceId: "sikong", taskId }),
      ).toMatchObject({
        ok: true,
        data: { projection: { taskId, status: "created" } },
      });
      expect(
        await callTool(tools, "waitTask", {
          workspaceId: "sikong",
          taskId,
          timeoutMs: 0,
        }),
      ).toMatchObject({
        ok: true,
        data: {
          compact: {
            taskId,
            workspaceId: "sikong",
            status: "created",
            nextAction: { type: "start_lead_requirement_spec" },
          },
        },
      });

      expect(
        await callTool(tools, "removeWorkspacePreference", {
          workspaceId: "sikong",
          preferenceId: "run-bun-run-check",
        }),
      ).toEqual({
        ok: true,
        data: { preferenceId: "run-bun-run-check" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns structured command errors for invalid required input", async () => {
    const dir = await tmp();
    try {
      const tools = createClientAgentTools({ ctx: ctx(dir) });

      expect(await callTool(tools, "createTask", { workspaceId: "sikong" })).toEqual({
        ok: false,
        error: {
          code: "invalid_input",
          message: "request must be a non-empty string.",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function schemaRequired(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || !("required" in schema)) return [];
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) ? required : [];
}
