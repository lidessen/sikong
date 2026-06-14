import { mockLoop } from "agent-loop";
import {
  FileClientWorkLog,
  listTasks,
  listWorkspacePreferences,
  listWorkspaces,
  resolveDataDir,
  runClientAgentTurn,
  type ClientWorkLogEntryKind,
  type CommandContext,
} from "@sikong/workspace";

const port = Number(process.env.SIKONG_CLIENT_API_PORT ?? 8776);
const dataDir = resolveDataDir().dir;

function commandContext(workspaceId?: string): CommandContext {
  return {
    dataDir,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ ok: true, dataDir });
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        return json(await clientState(url.searchParams.get("workspaceId") ?? undefined));
      }
      if (request.method === "POST" && url.pathname === "/api/work-log") {
        const body = await request.json();
        const ctx = commandContext(optionalStringField(body, "workspaceId"));
        const entry = await new FileClientWorkLog(dataDir).append(ctx, {
          kind: workLogKindField(body, "kind"),
          summary: stringField(body, "summary"),
          workspaceId: optionalStringField(body, "workspaceId"),
          relatedTaskIds: optionalStringArrayField(body, "relatedTaskIds"),
        });
        return json(entry, 201);
      }
      if (request.method === "POST" && url.pathname === "/api/turn") {
        const body = await request.json();
        const workspaceId = optionalStringField(body, "workspaceId");
        const taskId = optionalStringField(body, "taskId");
        const result = await runClientAgentTurn({
          ctx: commandContext(workspaceId),
          loop: mockLoop(),
          message: stringField(body, "message"),
          focus: {
            ...(workspaceId ? { workspaceId } : {}),
            ...(taskId ? { taskId } : {}),
          },
        });
        return json({
          text: result.run.text,
          status: result.run.status,
          context: result.context,
          message: {
            id: crypto.randomUUID(),
            role: "assistant",
            createdAt: new Date().toISOString(),
            parts: [
              {
                type: "text",
                text: result.run.text || `Turn finished with status ${result.run.status}.`,
              },
            ],
          },
        });
      }
      return json({ message: "route not found" }, 404);
    } catch (err) {
      return json({ message: err instanceof Error ? err.message : String(err) }, 400);
    }
  },
});

console.log(`sikong client api listening on http://127.0.0.1:${port}`);

async function clientState(workspaceId?: string) {
  const workspacesResult = await listWorkspaces(commandContext());
  if (!workspacesResult.ok) throw new Error(workspacesResult.error.message);
  const workspaces = workspacesResult.data.workspaces;
  const selectedWorkspaceId = workspaceId ?? workspaces[0]?.id;
  const ctx = commandContext(selectedWorkspaceId);
  const workLog = await new FileClientWorkLog(dataDir).list({ limit: 40 });
  if (!selectedWorkspaceId) {
    return {
      workspaces,
      taskCards: [],
      preferences: [],
      workLog,
    };
  }

  const [tasks, preferences] = await Promise.all([
    listTasks(ctx, { workspaceId: selectedWorkspaceId }),
    listWorkspacePreferences(ctx, { workspaceId: selectedWorkspaceId }),
  ]);
  return {
    workspaces,
    selectedWorkspaceId,
    taskCards: tasks.ok ? tasks.data.tasks : [],
    preferences: preferences.ok ? preferences.data.preferences : [],
    workLog,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stringField(body: unknown, key: string): string {
  if (!body || typeof body !== "object") throw new Error("JSON body is required");
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalStringField(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalStringArrayField(body: unknown, key: string): string[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && !!item.trim());
}

function workLogKindField(body: unknown, key: string): ClientWorkLogEntryKind {
  const value = stringField(body, key);
  if (
    value === "task_summary" ||
    value === "decision" ||
    value === "user_preference" ||
    value === "project_status"
  ) {
    return value;
  }
  throw new Error(`${key} is not a supported work-log kind`);
}
