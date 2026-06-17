import {
  DaemonProcessClient,
  discoverRuntimeSettingsOptions,
  FileClientWorkLog,
  FileSettingsStore,
  inspectTaskDetail,
  listWorkspacePreferences,
  listWorkspaces,
  resolveDataDir,
  runClientAgentTurn,
  type ClientWorkLogEntryKind,
  type ClientTranscriptSource,
  type CommandContext,
  type ProcessRunSnapshot,
  type SikongSettings,
} from "@sikong/workspace";
import { join } from "node:path";
import type {
  ClientAgentContextPacket,
  ClientMessage,
  ClientTurnActivity,
  ClientTurnProgressPhaseId,
  TurnResponse,
  TurnStreamEvent,
} from "../src/types";
import { createActivityThrottle } from "./activity-throttle";
import { borrowClientAgentLoop, invalidateClientRuntimePool } from "./client-runtime-pool";
import {
  appendTranscriptMessage,
  deleteTranscriptMessageById,
  readTranscript,
  transcriptPaths,
} from "./client-transcript";
import {
  invalidateWorkspaceProjectionCache,
  loadWorkspaceProjectionSnapshot,
} from "./client-workspace-cache";
import { createSseResponse } from "./sse-stream";
import { createTurnSession, resumeTurnSession } from "./turn-registry";
import { withTurnMutex } from "./turn-mutex";

const port = Number(process.env.SIKONG_CLIENT_API_PORT ?? 8776);
let dataDir = resolveDataDir().dir;

function transcriptPathsForDataDir() {
  return transcriptPaths(dataDir);
}

let settingsStore = new FileSettingsStore(dataDir);

export function __testSetDataDir(dir: string): void {
  dataDir = dir;
  settingsStore = new FileSettingsStore(dataDir);
}
const clientDistDir = process.env.SIKONG_CLIENT_DIST_DIR ?? join(import.meta.dir, "..", "dist");
const turnStreamHeartbeatMs = 5_000;
const turnTimeoutMs = Number(process.env.SIKONG_CLIENT_TURN_TIMEOUT_MS ?? 120_000);
const startedAt = new Date().toISOString();

process.on("uncaughtException", (err) => {
  logServerError("uncaughtException", err);
});

process.on("unhandledRejection", (err) => {
  logServerError("unhandledRejection", err);
});

function commandContext(workspaceId?: string): CommandContext {
  return {
    dataDir,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

if (import.meta.main) {
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    error(error) {
      logServerError("serve.error", error);
      return json({ message: "internal server error" }, 500);
    },
    async fetch(request, server) {
      const url = new URL(request.url);
      try {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders() });
        }
        if (request.method === "GET" && url.pathname === "/api/health") {
          return json({
            ok: true,
            dataDir,
            startedAt,
            uptimeMs: Math.round(process.uptime() * 1000),
          });
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
          return json(await settingsResponse(await settingsStore.read()));
        }
        if (request.method === "GET" && url.pathname === "/api/settings/options") {
          return json(await discoverRuntimeSettingsOptions());
        }
        if (request.method === "GET" && url.pathname === "/api/transcript") {
          return json(await readTranscript(transcriptPathsForDataDir().transcriptPath));
        }
        if (request.method === "DELETE" && url.pathname.startsWith("/api/transcript/")) {
          const messageId = decodeURIComponent(url.pathname.slice("/api/transcript/".length));
          if (!messageId) return json({ message: "messageId is required" }, 400);
          return json(await deleteTranscriptMessage(messageId));
        }
        if (request.method === "PUT" && url.pathname === "/api/settings") {
          const saved = await settingsStore.write((await request.json()) as SikongSettings);
          await invalidateClientRuntimePool();
          return json(await settingsResponse(saved));
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
          invalidateWorkspaceProjectionCache(optionalStringField(body, "workspaceId"));
          return json(entry, 201);
        }
        if (request.method === "POST" && url.pathname === "/api/turn/stream") {
          server.timeout(request, 0);
          const body = await request.json();
          const input = parseTurnRequest(body);
          return startTurnStreamResponse(input, request.signal);
        }
        if (request.method === "GET" && url.pathname.startsWith("/api/turn/") && url.pathname.endsWith("/stream")) {
          server.timeout(request, 0);
          const turnId = decodeURIComponent(url.pathname.slice("/api/turn/".length, -"/stream".length));
          const after = Number(url.searchParams.get("after") ?? "-1");
          return resumeTurnStreamResponse(turnId, Number.isFinite(after) ? after : -1, request.signal);
        }
        if (request.method === "POST" && url.pathname === "/api/turn") {
          server.timeout(request, 0);
          const body = await request.json();
          const input = parseTurnRequest(body);
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => {
            if (!abortController.signal.aborted) abortController.abort("timeout");
          }, turnTimeoutMs);
          request.signal.addEventListener(
            "abort",
            () => abortController.abort("cancelled"),
            { once: true },
          );
          try {
            return json(await runTurnWorkflow(input, undefined, abortController.signal));
          } finally {
            clearTimeout(timeoutId);
          }
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
}
interface TurnRequestInput {
  message: string;
  workspaceId?: string;
  taskId?: string;
}

interface TurnProgressUpdate {
  phaseId: ClientTurnProgressPhaseId;
  detail?: string;
}

interface TurnActivityUpdate {
  activity: ClientTurnActivity;
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

export async function runTurnWorkflow(
  input: TurnRequestInput,
  onUpdate?: (update: TurnProgressUpdate | TurnActivityUpdate) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<TurnWorkflowResponse> {
  return await withTurnMutex(async () => runTurnWorkflowInner(input, onUpdate, signal));
}

async function runTurnWorkflowInner(
  input: TurnRequestInput,
  onUpdate?: (update: TurnProgressUpdate | TurnActivityUpdate) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<TurnWorkflowResponse> {
  // Early return if turn was cancelled before work started
  if (signal?.aborted) {
    const message = textMessage("system", "Turn was cancelled before execution began.");
    await appendTranscript(message);
    return {
      text: "",
      status: "cancelled",
      context: emptyClientAgentContext(),
      message,
    };
  }

  const progress = (update: TurnProgressUpdate) => {
    void onUpdate?.(update);
  };
  const activityThrottle = createActivityThrottle((activity) => {
    void onUpdate?.({ activity });
  });
  const userMessage = textMessage("user", input.message);
  await appendTranscript(userMessage);
  progress({
    phaseId: "context",
    detail: "User message saved. Loading workspace context and runtime settings.",
  });

  const settings = await settingsStore.read();
  const loop = await borrowClientAgentLoop(settings.defaults.clientAgent);
  await assertRuntimePreflight(loop);

  progress({
    phaseId: "agent",
    detail: "Context is ready. Running the client agent model/tool loop.",
  });

  // Keep the LLM pass slightly shorter than the server turn timeout.
  const passTimeoutMs = Math.max(30_000, turnTimeoutMs - 5_000);

  try {
    const result = await runClientAgentTurn({
      ctx: commandContext(input.workspaceId),
      loop,
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
      passTimeoutMs,
      signal,
      onActivity: (item) => activityThrottle.emit(item),
    });
    activityThrottle.flush();

    // Check for cancellation that occurred during the LLM pass
    if (signal?.aborted || result.run.status === "cancelled") {
      const reason = signal?.reason === "timeout" ? "timed out" : "cancelled";
      const message = textMessage("system", `Turn was ${reason} during execution.`);
      await appendTranscript(message);
      return {
        text: "",
        status: "cancelled",
        context: result.context,
        message,
      };
    }

    progress({
      phaseId: "workspace",
      detail: "Agent result received. Waking the background scheduler.",
    });
    const schedulerWake = await wakeScheduler();
    if (input.workspaceId) {
      invalidateWorkspaceProjectionCache(input.workspaceId);
    }
    const responseText = result.outcomeText;
    const assistantMessage = assistantMessageFromTurn(result, responseText);
    await appendTranscript(assistantMessage);

    progress({
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
  } finally {
    activityThrottle.flush();
  }
}

function emptyClientAgentContext(): ClientAgentContextPacket {
  return {
    policy: {
      transcript: "query_with_tools",
      workspaceState: "authoritative",
      taskEvents: "inspect_on_demand",
      memory: "none",
    },
    focus: {},
    currentMessage: { id: "", text: "", createdAt: "" },
    workspaceIndex: [],
    recentTranscript: [],
  };
}

async function assertRuntimePreflight(loop: {
  id: string;
  preflight: () => Promise<{ ok: boolean; reason?: string; missingEnv?: string[] }>;
}): Promise<void> {
  const preflight = await loop.preflight();
  if (preflight.ok) return;
  const missing = preflight.missingEnv?.length
    ? ` Missing env: ${preflight.missingEnv.join(", ")}.`
    : "";
  throw new Error(
    `Client agent backend "${loop.id}" is not ready: ${preflight.reason ?? "preflight failed"}.${missing}`,
  );
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

function startTurnStreamResponse(input: TurnRequestInput, signal: AbortSignal): Response {
  const session = createTurnSession();
  if (!signal.aborted) {
    signal.addEventListener("abort", () => session.abortController.abort("cancelled"), {
      once: true,
    });
  } else {
    session.abortController.abort("cancelled");
  }
  return attachTurnStream(session, {
    run: () => executeTurnSession(session, input),
  });
}

function resumeTurnStreamResponse(turnId: string, afterIndex: number, signal: AbortSignal): Response {
  const session = resumeTurnSession(turnId);
  if (!session) {
    return json({ message: `turn ${turnId} is not active or resumable` }, 404);
  }
  if (!signal.aborted) {
    signal.addEventListener("abort", () => session.subscriberDisconnected(), { once: true });
  }
  return attachTurnStream(session, { afterIndex });
}

function attachTurnStream(
  session: ReturnType<typeof createTurnSession>,
  options: { afterIndex?: number; run?: () => Promise<void> } = {},
): Response {
  const timeoutId = setTimeout(() => {
    if (!session.abortController.signal.aborted) {
      session.abortController.abort("timeout");
    }
  }, turnTimeoutMs);
  session.abortController.signal.addEventListener("abort", () => clearTimeout(timeoutId), {
    once: true,
  });

  return createSseResponse(
    (emit) => {
      const send = (event: TurnStreamEvent): void => {
        emit.send(event);
        if (
          event.type === "turn.completed" ||
          event.type === "turn.error" ||
          event.type === "turn.cancelled"
        ) {
          emit.close();
        }
      };

      session.attach(send, options.afterIndex ?? -1);
      if (options.run) {
        void options.run().finally(() => clearTimeout(timeoutId));
      }
    },
    turnStreamHeartbeatMs,
    corsHeaders(),
    () => {
      clearTimeout(timeoutId);
      session.subscriberDisconnected();
    },
  );
}

async function executeTurnSession(
  session: ReturnType<typeof createTurnSession>,
  input: TurnRequestInput,
): Promise<void> {
  const { turnId, segmentId, abortController } = session;

  session.publish({
    type: "turn.started",
    turnId,
    segmentId,
    startedAt: session.startedAt,
    phaseId: "prepare",
    detail: "Turn accepted. Preparing transcript and focus context.",
  });

  const onAbort = (): void => {
    session.publish({
      type: "turn.cancelled",
      turnId,
      segmentId,
      reason: abortController.signal.reason === "timeout" ? "timeout" : "cancelled",
      at: new Date().toISOString(),
    });
    session.cancel(abortController.signal.reason === "timeout" ? "timeout" : "cancelled");
  };
  abortController.signal.addEventListener("abort", onAbort, { once: true });

  if (abortController.signal.aborted) {
    onAbort();
    return;
  }

  try {
    const response = await runTurnWorkflow(
      input,
      (update) => {
        if (abortController.signal.aborted) return;
        if ("activity" in update) {
          session.publish({
            type: "turn.activity",
            turnId,
            segmentId,
            activity: update.activity,
            at: new Date().toISOString(),
          });
          return;
        }
        session.publish({
          type: "turn.progress",
          turnId,
          segmentId,
          phaseId: update.phaseId,
          detail: update.detail,
          at: new Date().toISOString(),
        });
      },
      abortController.signal,
    );
    abortController.signal.removeEventListener("abort", onAbort);
    if (abortController.signal.aborted) return;
    session.publish({
      type: "turn.completed",
      turnId,
      segmentId,
      response,
      at: new Date().toISOString(),
    });
    session.complete(response);
  } catch (err) {
    abortController.signal.removeEventListener("abort", onAbort);
    if (abortController.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    session.publish({
      type: "turn.error",
      turnId,
      segmentId,
      message,
      at: new Date().toISOString(),
    });
    session.fail(message);
  }
}

async function clientState(workspaceId?: string) {
  const [settings, workspacesResult, scheduler, transcript] = await Promise.all([
    settingsStore.read(),
    listWorkspaces(commandContext()),
    schedulerStatus(),
    readTranscript(transcriptPathsForDataDir().transcriptPath),
  ]);
  if (!workspacesResult.ok) throw new Error(workspacesResult.error.message);
  const workspaces = await Promise.all(workspacesResult.data.workspaces.map(workspaceView));
  const selectedWorkspaceId = workspaceId ?? workspaces[0]?.id;
  const ctx = commandContext(selectedWorkspaceId);
  const workLog = await new FileClientWorkLog(dataDir).list({ limit: 40 });
  if (!selectedWorkspaceId) {
    return {
      workspaces,
      taskCards: [],
      preferences: [],
      workLog,
      transcript,
      settings,
      scheduler,
      diagnostics: buildClientDiagnostics(scheduler),
    };
  }

  const [snapshot, preferences] = await Promise.all([
    loadWorkspaceProjectionSnapshot(dataDir, selectedWorkspaceId),
    listWorkspacePreferences(ctx, { workspaceId: selectedWorkspaceId }),
  ]);
  return {
    workspaces,
    selectedWorkspaceId,
    taskCards: snapshot.taskCards,
    preferences: preferences.ok ? preferences.data.preferences : [],
    workLog,
    transcript,
    settings,
    scheduler,
    diagnostics: buildClientDiagnostics(scheduler),
  };
}

function buildClientDiagnostics(scheduler: Awaited<ReturnType<typeof schedulerStatus>>) {
  return {
    clientApi: { ok: true },
    daemon: scheduler,
  };
}

function assistantMessageFromTurn(
  result: Awaited<ReturnType<typeof runClientAgentTurn>>,
  fallbackText: string,
): ClientMessage {
  if (result.outcome) {
    return {
      id: crypto.randomUUID(),
      role: "assistant",
      createdAt: new Date().toISOString(),
      parts: [{ type: "outcome-card", outcome: result.outcome }],
    };
  }
  return textMessage("assistant", fallbackText || `Turn finished with status ${result.run.status}.`);
}

async function settingsResponse(settings: SikongSettings) {
  return {
    ...settings,
    options: await discoverRuntimeSettingsOptions(),
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
  const snapshot = await loadWorkspaceProjectionSnapshot(dataDir, workspace.id);
  const tasks = snapshot.facts;
  return {
    ...workspace,
    sourceKind: tasks.hasGit ? "git" : tasks.hasDirectory ? "directory" : "empty",
    taskCount: tasks.total,
    activeTaskCount: tasks.active,
  };
}

function logServerError(kind: string, err: unknown): void {
  const message = err instanceof Error ? `${err.stack ?? err.message}` : String(err);
  console.error(`[sikong-client-api] ${kind}: ${message}`);
}

function textMessage(role: "user" | "assistant" | "system", text: string): ClientMessage {
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
      if (part.type === "outcome-card") {
        return part.outcome.kind === "report"
          ? `${part.outcome.title}\n${part.outcome.summary}`
          : part.outcome.kind === "question"
            ? part.outcome.question
            : `${part.outcome.title}\n${part.outcome.body}`;
      }
      if (part.type === "ui") return part.spec.root;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function transcriptSource(options: { excludeMessageId?: string } = {}): ClientTranscriptSource {
  const load = async () => {
    const messages = await readTranscript(transcriptPathsForDataDir().transcriptPath);
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

async function appendTranscript(message: ClientMessage): Promise<void> {
  const { transcriptPath, lockPath } = transcriptPathsForDataDir();
  await appendTranscriptMessage(transcriptPath, lockPath, message);
}

async function deleteTranscriptMessage(messageId: string): Promise<ClientMessage[]> {
  const { transcriptPath, lockPath } = transcriptPathsForDataDir();
  return await deleteTranscriptMessageById(transcriptPath, lockPath, messageId);
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(100, Math.floor(value))) : 20;
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
