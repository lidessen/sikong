import {
  createDefaultRuntimeAssemblyRegistry,
  acceptPlan,
  driveTask,
  FileClientWorkLog,
  FileSettingsStore,
  listTasks,
  listWorkspacePreferences,
  listWorkspaces,
  rejectPlan,
  resolveDataDir,
  runClientAgentTurn,
  type ClientWorkLogEntryKind,
  type CommandContext,
  type SikongSettings,
} from "@sikong/workspace";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ClientMessage } from "../src/types";

const port = Number(process.env.SIKONG_CLIENT_API_PORT ?? 8776);
const dataDir = resolveDataDir().dir;
const settingsStore = new FileSettingsStore(dataDir);
const transcriptPath = join(dataDir, "state", "client-transcript.json");
const clientDistDir = process.env.SIKONG_CLIENT_DIST_DIR ?? join(import.meta.dir, "..", "dist");

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
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ ok: true, dataDir });
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        return json(await clientState(url.searchParams.get("workspaceId") ?? undefined));
      }
      if (request.method === "GET" && url.pathname === "/api/settings") {
        return json(await settingsStore.read());
      }
      if (request.method === "GET" && url.pathname === "/api/transcript") {
        return json(await readTranscript());
      }
      if (request.method === "PUT" && url.pathname === "/api/settings") {
        return json(await settingsStore.write((await request.json()) as SikongSettings));
      }
      if (request.method === "POST" && url.pathname === "/api/tasks/plan-decision") {
        const body = await request.json();
        const decision = stringField(body, "decision");
        const ctx = commandContext(stringField(body, "workspaceId"));
        const input = {
          workspaceId: stringField(body, "workspaceId"),
          taskId: stringField(body, "taskId"),
          planId: stringField(body, "planId"),
          version: numberField(body, "version"),
          report:
            decision === "accept"
              ? "Accepted from Sikong client UI."
              : "Rejected from Sikong client UI.",
        };
        const result =
          decision === "accept"
            ? await acceptPlan(ctx, input)
            : await rejectPlan(ctx, {
                ...input,
                requestedChanges: "Rejected from Sikong client UI.",
              });
        if (!result.ok) throw new Error(result.error.message);
        const driven =
          decision === "accept"
            ? await driveTask(ctx, {
                workspaceId: stringField(body, "workspaceId"),
                taskId: stringField(body, "taskId"),
                processTimeoutMs: 600_000,
              })
            : undefined;
        return json({ decision: result.data, driven: summarizeDriveResult(driven) });
      }
      if (request.method === "POST" && url.pathname === "/api/tasks/drive") {
        const body = await request.json();
        const result = await driveTask(commandContext(stringField(body, "workspaceId")), {
          workspaceId: stringField(body, "workspaceId"),
          taskId: stringField(body, "taskId"),
          processTimeoutMs: 600_000,
        });
        if (!result.ok) throw new Error(result.error.message);
        return json(summarizeDriveResult(result));
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
        const beforeTasks = await taskSnapshot();
        const userMessage = textMessage("user", stringField(body, "message"));
        await appendTranscript(userMessage);
        const settings = await settingsStore.read();
        const runtime = await createDefaultRuntimeAssemblyRegistry().createExecutionRuntime({
          backend: {
            name: settings.defaults.clientAgent.backend,
            options: runtimeOptions(settings.defaults.clientAgent),
          },
        });
        if (!runtime.loop) throw new Error("client agent backend did not create an agent loop");
        const result = await runClientAgentTurn({
          ctx: commandContext(workspaceId),
          loop: runtime.loop,
          message: messageText(userMessage),
          focus: {
            ...(workspaceId ? { workspaceId } : {}),
            ...(taskId ? { taskId } : {}),
          },
        });
        const assistantMessage = textMessage(
          "assistant",
          result.run.text || `Turn finished with status ${result.run.status}.`,
        );
        await appendTranscript(assistantMessage);
        const autoDriven = await autoDriveNewTasks(beforeTasks);
        return json({
          text: result.run.text,
          status: result.run.status,
          context: result.context,
          message: assistantMessage,
          autoDriven,
        });
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const response = await staticResponse(url.pathname, request.method === "HEAD");
        if (response) return response;
      }
      return json({ message: "route not found" }, 404);
    } catch (err) {
      return json({ message: err instanceof Error ? err.message : String(err) }, 400);
    }
  },
});

console.log(`sikong client api listening on http://127.0.0.1:${port}`);

async function clientState(workspaceId?: string) {
  const [settings, workspacesResult] = await Promise.all([
    settingsStore.read(),
    listWorkspaces(commandContext()),
  ]);
  if (!workspacesResult.ok) throw new Error(workspacesResult.error.message);
  const workspaces = workspacesResult.data.workspaces;
  const selectedWorkspaceId = workspaceId ?? workspaces[0]?.id;
  const ctx = commandContext(selectedWorkspaceId);
  const [workLog, transcript] = await Promise.all([
    new FileClientWorkLog(dataDir).list({ limit: 40 }),
    readTranscript(),
  ]);
  if (!selectedWorkspaceId) {
    return {
      workspaces,
      taskCards: [],
      preferences: [],
      workLog,
      transcript,
      settings,
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
    transcript,
    settings,
  };
}

async function taskSnapshot(): Promise<Set<string>> {
  const workspacesResult = await listWorkspaces(commandContext());
  if (!workspacesResult.ok) throw new Error(workspacesResult.error.message);
  const ids = new Set<string>();
  for (const workspace of workspacesResult.data.workspaces) {
    const tasks = await listTasks(commandContext(workspace.id), { workspaceId: workspace.id });
    if (!tasks.ok) continue;
    for (const task of tasks.data.tasks) {
      ids.add(taskKey(task.workspaceId, task.taskId));
    }
  }
  return ids;
}

async function autoDriveNewTasks(before: Set<string>): Promise<unknown[]> {
  const workspacesResult = await listWorkspaces(commandContext());
  if (!workspacesResult.ok) throw new Error(workspacesResult.error.message);
  const driven: unknown[] = [];
  for (const workspace of workspacesResult.data.workspaces) {
    const tasks = await listTasks(commandContext(workspace.id), { workspaceId: workspace.id });
    if (!tasks.ok) continue;
    for (const task of tasks.data.tasks) {
      if (before.has(taskKey(task.workspaceId, task.taskId))) continue;
      if (task.nextAction.type !== "start_planning_worker") continue;
      const result = await driveTask(commandContext(task.workspaceId), {
        workspaceId: task.workspaceId,
        taskId: task.taskId,
        processTimeoutMs: 600_000,
      });
      driven.push({
        workspaceId: task.workspaceId,
        taskId: task.taskId,
        result: summarizeDriveResult(result),
      });
    }
  }
  return driven;
}

function summarizeDriveResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  if (record.ok !== true) return result;
  const data = record.data;
  if (!data || typeof data !== "object") return result;
  const drive = data as Record<string, unknown>;
  return {
    ok: true,
    data: {
      taskId: drive.taskId,
      stopReason: drive.stopReason,
      steps: Array.isArray(drive.steps)
        ? drive.steps.map((step) => {
            const stepRecord = step as Record<string, unknown>;
            const action = stepRecord.action as Record<string, unknown> | undefined;
            const resultRecord = stepRecord.result as Record<string, unknown> | undefined;
            return {
              actionType: action?.type,
              resultType: resultRecord?.resultType,
              waitFor: resultRecord?.waitFor,
            };
          })
        : [],
      projection:
        drive.projection && typeof drive.projection === "object"
          ? {
              taskId: (drive.projection as Record<string, unknown>).taskId,
              status: (drive.projection as Record<string, unknown>).status,
              updatedAt: (drive.projection as Record<string, unknown>).updatedAt,
            }
          : undefined,
    },
  };
}

function taskKey(workspaceId: string, taskId: string): string {
  return `${workspaceId}:${taskId}`;
}

async function readTranscript(): Promise<ClientMessage[]> {
  try {
    const value = JSON.parse(await readFile(transcriptPath, "utf8")) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(isClientMessage);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function appendTranscript(message: ClientMessage): Promise<void> {
  const transcript = await readTranscript();
  transcript.push(message);
  await mkdir(dirname(transcriptPath), { recursive: true });
  const tmp = `${transcriptPath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(transcript.slice(-200), null, 2));
  await rename(tmp, transcriptPath);
}

function textMessage(role: "user" | "assistant", text: string): ClientMessage {
  return {
    id: crypto.randomUUID(),
    role,
    createdAt: new Date().toISOString(),
    parts: [{ type: "text", text }],
  };
}

function messageText(message: ClientMessage): string {
  const part = message.parts.find((item) => item.type === "text");
  return part?.type === "text" ? part.text : "";
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    (record.role === "user" || record.role === "assistant" || record.role === "system") &&
    typeof record.createdAt === "string" &&
    Array.isArray(record.parts)
  );
}

function runtimeOptions(runtime: { provider?: string; model?: string }): Record<string, string> {
  return {
    ...(runtime.provider ? { provider: runtime.provider } : {}),
    ...(runtime.model ? { model: runtime.model } : {}),
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

async function staticResponse(pathname: string, head = false): Promise<Response | undefined> {
  const path = safeStaticPath(pathname);
  if (!path) return json({ message: "invalid path" }, 400);
  const filePath = join(clientDistDir, path === "/" ? "index.html" : path.slice(1));
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(head ? null : file, { headers: { "content-type": contentType(filePath) } });
  }
  const index = Bun.file(join(clientDistDir, "index.html"));
  if (await index.exists()) {
    return new Response(head ? null : index, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return undefined;
}

function safeStaticPath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith("/") || decoded.includes("..") || decoded.includes("\\")) {
    return undefined;
  }
  return decoded;
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
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

function numberField(body: unknown, key: string): number {
  if (!body || typeof body !== "object") throw new Error("JSON body is required");
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return value;
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
