import {
  createDefaultRuntimeAssemblyRegistry,
  DaemonProcessClient,
  FileClientWorkLog,
  FileSettingsStore,
  inspectTaskDetail,
  listTasks,
  listWorkspacePreferences,
  listWorkspaces,
  resolveDataDir,
  runClientAgentTurn,
  runtimeSettingsOptions,
  taskProjectionsDir,
  type ClientWorkLogEntryKind,
  type ClientTranscriptSource,
  type CommandContext,
  type ProcessRunSnapshot,
  type SikongSettings,
  type TaskProjection,
} from "@sikong/workspace";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ClientMessage,
  ClientTurnProgressPhaseId,
  TurnResponse,
  TurnStreamEvent,
} from "../src/types";

const port = Number(process.env.SIKONG_CLIENT_API_PORT ?? 8776);
const dataDir = resolveDataDir().dir;
const settingsStore = new FileSettingsStore(dataDir);
const transcriptPath = join(dataDir, "state", "client-transcript.json");
const clientDistDir = process.env.SIKONG_CLIENT_DIST_DIR ?? join(import.meta.dir, "..", "dist");
const turnStreamHeartbeatMs = 5_000;

function commandContext(workspaceId?: string): CommandContext {
  return {
    dataDir,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request, server) {
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
      if (request.method === "GET" && url.pathname === "/api/task-detail") {
        const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
        const taskId = url.searchParams.get("taskId");
        if (!taskId) return json({ message: "taskId is required" }, 400);
        const detail = await inspectTaskDetail(commandContext(workspaceId), {
          workspaceId,
          taskId,
        });
        if (!detail.ok) return json({ message: detail.error.message }, 400);
        const processRuns = await taskProcessRuns(workspaceId, taskId);
        return json({
          ...detail.data.detail,
          processRuns: processRuns.runs,
          ...(processRuns.error ? { processRunError: processRuns.error } : {}),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/settings") {
        return json(settingsResponse(await settingsStore.read()));
      }
      if (request.method === "GET" && url.pathname === "/api/transcript") {
        return json(await readTranscript());
      }
      if (request.method === "PUT" && url.pathname === "/api/settings") {
        return json(
          settingsResponse(await settingsStore.write((await request.json()) as SikongSettings)),
        );
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
      if (request.method === "POST" && url.pathname === "/api/turn/stream") {
        server.timeout(request, 0);
        const body = await request.json();
        const input = parseTurnRequest(body);
        return turnStreamResponse(input);
      }
      if (request.method === "POST" && url.pathname === "/api/turn") {
        const body = await request.json();
        return json(await runTurnWorkflow(parseTurnRequest(body)));
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

interface TurnRequestInput {
  message: string;
  workspaceId?: string;
  taskId?: string;
}

interface TurnProgressUpdate {
  phaseId: ClientTurnProgressPhaseId;
  detail?: string;
}

interface TurnWorkflowResponse extends TurnResponse {
  schedulerWake?: SchedulerWakeResult;
}

interface SchedulerWakeResult {
  ok: boolean;
  error?: string;
}

function parseTurnRequest(body: unknown): TurnRequestInput {
  return {
    message: stringField(body, "message"),
    workspaceId: optionalStringField(body, "workspaceId"),
    taskId: optionalStringField(body, "taskId"),
  };
}

async function runTurnWorkflow(
  input: TurnRequestInput,
  onProgress?: (update: TurnProgressUpdate) => void | Promise<void>,
): Promise<TurnWorkflowResponse> {
  const progress = async (update: TurnProgressUpdate) => {
    await onProgress?.(update);
  };
  const userMessage = textMessage("user", input.message);
  await appendTranscript(userMessage);
  await progress({
    phaseId: "context",
    detail: "User message saved. Loading workspace context and runtime settings.",
  });

  const settings = await settingsStore.read();
  const runtime = await createDefaultRuntimeAssemblyRegistry().createExecutionRuntime({
    backend: {
      name: settings.defaults.clientAgent.backend,
      options: runtimeOptions(settings.defaults.clientAgent),
    },
  });
  if (!runtime.loop) throw new Error("client agent backend did not create an agent loop");

  await progress({
    phaseId: "agent",
    detail: "Context is ready. Running the client agent model/tool loop.",
  });
  const result = await runClientAgentTurn({
    ctx: commandContext(input.workspaceId),
    loop: runtime.loop,
    message: messageText(userMessage),
    currentMessage: {
      id: userMessage.id,
      text: messageText(userMessage),
      createdAt: userMessage.createdAt,
    },
    focus: {
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    },
    transcript: transcriptSource({ excludeMessageId: userMessage.id }),
    maxSteps: 4,
    settlementMaxSteps: 1,
    passTimeoutMs: 60_000,
    settlementPassTimeoutMs: 20_000,
  });

  await progress({
    phaseId: "workspace",
    detail: "Agent result received. Waking the background scheduler.",
  });
  const schedulerWake = await wakeScheduler();
  const responseText = result.outcomeText;
  const assistantMessage = textMessage(
    "assistant",
    responseText || `Turn finished with status ${result.run.status}.`,
  );
  await appendTranscript(assistantMessage);

  await progress({
    phaseId: "refresh",
    detail: "Workspace changes are persisted. Refreshing the UI projection.",
  });
  return {
    text: responseText,
    status: "completed",
    context: result.context,
    outcome: result.outcome,
    message: assistantMessage,
    schedulerWake,
  };
}

function daemonProcessBaseUrl(): string {
  const raw = process.env.SIKONG_DAEMON_ADDR ?? "127.0.0.1:8765";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw.replace(/\/+$/, "");
  return `http://${raw.replace(/\/+$/, "")}`;
}

async function wakeScheduler(): Promise<SchedulerWakeResult> {
  try {
    await new DaemonProcessClient({ baseUrl: daemonProcessBaseUrl() }).wakeScheduler();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function turnStreamResponse(input: TurnRequestInput): Response {
  const turnId = crypto.randomUUID();
  const segmentId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const clearHeartbeat = () => {
    if (heartbeat === undefined) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (payload: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(payload));
          return true;
        } catch {
          closed = true;
          clearHeartbeat();
          return false;
        }
      };
      const send = (event: TurnStreamEvent) => {
        write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        clearHeartbeat();
        try {
          controller.close();
        } catch {
          // The browser or Bun may have already closed the stream.
        }
      };

      heartbeat = setInterval(() => {
        write(`: heartbeat ${new Date().toISOString()}\n\n`);
      }, turnStreamHeartbeatMs);

      void (async () => {
        send({
          type: "turn.started",
          turnId,
          segmentId,
          startedAt,
          phaseId: "prepare",
          detail: "Turn accepted. Preparing transcript and focus context.",
        });
        try {
          const response = await runTurnWorkflow(input, (update) => {
            send({
              type: "turn.progress",
              turnId,
              segmentId,
              phaseId: update.phaseId,
              detail: update.detail,
              at: new Date().toISOString(),
            });
          });
          send({
            type: "turn.completed",
            turnId,
            segmentId,
            response,
            at: new Date().toISOString(),
          });
        } catch (err) {
          send({
            type: "turn.error",
            turnId,
            segmentId,
            message: err instanceof Error ? err.message : String(err),
            at: new Date().toISOString(),
          });
        } finally {
          close();
        }
      })();
    },
    cancel() {
      closed = true;
      clearHeartbeat();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

async function clientState(workspaceId?: string) {
  const [settings, workspacesResult, scheduler] = await Promise.all([
    settingsStore.read(),
    listWorkspaces(commandContext()),
    schedulerStatus(),
  ]);
  if (!workspacesResult.ok) throw new Error(workspacesResult.error.message);
  const workspaces = await Promise.all(workspacesResult.data.workspaces.map(workspaceView));
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
      settingsOptions: runtimeSettingsOptions(),
      scheduler,
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
    settingsOptions: runtimeSettingsOptions(),
    scheduler,
  };
}

function settingsResponse(settings: SikongSettings) {
  return {
    ...settings,
    options: runtimeSettingsOptions(),
  };
}

async function schedulerStatus() {
  try {
    return await new DaemonProcessClient({ baseUrl: daemonProcessBaseUrl() }).schedulerStatus();
  } catch (err) {
    return {
      enabled: false,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function taskProcessRuns(
  workspaceId: string | undefined,
  taskId: string,
): Promise<{ runs: ProcessRunSnapshot[]; error?: string }> {
  try {
    const response = await new DaemonProcessClient({
      baseUrl: daemonProcessBaseUrl(),
    }).listProcessRuns({
      ...(workspaceId ? { workspaceId } : {}),
      taskId,
      limit: 80,
    });
    return { runs: response.runs };
  } catch (err) {
    return { runs: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function workspaceView(workspace: { id: string; name: string }) {
  const tasks = await workspaceTaskRuntimeFacts(workspace.id);
  return {
    ...workspace,
    sourceKind: tasks.hasGit ? "git" : tasks.hasDirectory ? "directory" : "empty",
    taskCount: tasks.total,
    activeTaskCount: tasks.active,
  };
}

async function workspaceTaskRuntimeFacts(workspaceId: string): Promise<{
  total: number;
  active: number;
  hasGit: boolean;
  hasDirectory: boolean;
}> {
  const dir = taskProjectionsDir(dataDir, workspaceId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { total: 0, active: 0, hasGit: false, hasDirectory: false };
    }
    throw err;
  }

  let total = 0;
  let active = 0;
  let hasGit = false;
  let hasDirectory = false;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    total += 1;
    const projection = JSON.parse(await readFile(join(dir, entry), "utf8")) as TaskProjection;
    if (!projection.terminal) active += 1;
    if (projection.runtime?.repoPath) hasGit = true;
    if (projection.runtime?.cwd) hasDirectory = true;
  }
  return { total, active, hasGit, hasDirectory };
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

function transcriptSearchText(message: ClientMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "task-card") return part.taskId;
      if (part.type === "work-log-summary") {
        return part.entries.map((entry) => entry.summary).join("\n");
      }
      if (part.type === "progress-card") return part.progress.title;
      if (part.type === "ui") return part.spec.root;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function transcriptSource(options: { excludeMessageId?: string } = {}): ClientTranscriptSource {
  const load = async () => {
    const messages = await readTranscript();
    return options.excludeMessageId
      ? messages.filter((message) => message.id !== options.excludeMessageId)
      : messages;
  };
  return {
    listRecent: async ({ limit = 12 } = {}) => {
      const messages = await load();
      return messages.slice(-normalizeLimit(limit));
    },
    search: async ({ query, limit = 20 }) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return [];
      const messages = await load();
      return messages
        .filter((message) => transcriptSearchText(message).toLowerCase().includes(needle))
        .slice(-normalizeLimit(limit));
    },
    getRange: async ({ beforeMessageId, limit = 20 } = {}) => {
      const messages = await load();
      const end = beforeMessageId
        ? Math.max(
            0,
            messages.findIndex((message) => message.id === beforeMessageId),
          )
        : messages.length;
      return messages.slice(Math.max(0, end - normalizeLimit(limit)), end);
    },
  };
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(100, Math.floor(value))) : 20;
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
