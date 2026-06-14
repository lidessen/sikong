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

async function callTool(tools: ToolSet, name: string, args: Record<string, unknown> = {}) {
  const tool = requireTool(tools, name);
  if (!tool.execute) throw new Error(`missing execute: ${name}`);
  return await tool.execute(args, {});
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
    expect(schemaRequired(requireTool(tools, "inspectTaskCompact").inputSchema)).toEqual([
      "taskId",
    ]);
  });

  test("expose workspace, preference, task, and inspect command handlers", async () => {
    const dir = await tmp();
    try {
      const tools = createClientAgentTools({ ctx: ctx(dir) });

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
        cwd: dir,
      });
      expect(createdTask).toMatchObject({
        ok: true,
        data: {
          taskId: "task_id_1",
          projection: {
            taskId: "task_id_1",
            status: "planning",
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

      expect(await callTool(tools, "getTask", { workspaceId: "sikong", taskId })).toMatchObject({
        ok: true,
        data: { projection: { taskId, status: "planning" } },
      });
      expect(await callTool(tools, "listTasks", { workspaceId: "sikong" })).toMatchObject({
        ok: true,
        data: { tasks: [{ taskId, status: "planning" }] },
      });
      expect(
        await callTool(tools, "inspectTaskSummary", { workspaceId: "sikong", taskId }),
      ).toMatchObject({
        ok: true,
        data: {
          summary: {
            taskId,
            status: "planning",
            planStatus: "requested",
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
            nextAction: { type: "start_planning_worker" },
            runtimeProcesses: { total: 0, running: 0 },
          },
        },
      });
      expect(
        await callTool(tools, "inspectTaskTrace", { workspaceId: "sikong", taskId }),
      ).toMatchObject({
        ok: true,
        data: {
          trace: [
            { type: "task.created", summary: "Implement client agent tools." },
            { type: "plan.requested", summary: "Implement client agent tools." },
          ],
        },
      });
      expect(
        await callTool(tools, "inspectTaskEvents", { workspaceId: "sikong", taskId }),
      ).toMatchObject({
        ok: true,
        data: { events: [{ type: "task.created" }, { type: "plan.requested" }] },
      });
      expect(
        await callTool(tools, "inspectTaskProjection", { workspaceId: "sikong", taskId }),
      ).toMatchObject({
        ok: true,
        data: { projection: { taskId, status: "planning" } },
      });
      expect(
        await callTool(tools, "waitTask", {
          workspaceId: "sikong",
          taskId,
          timeoutMs: 0,
        }),
      ).toMatchObject({
        ok: false,
        error: {
          code: "timeout",
          details: { taskId, workspaceId: "sikong" },
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
