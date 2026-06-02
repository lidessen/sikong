import { randomUUID } from "node:crypto";
import {
  defineTool,
  emptyUsage,
  type AgentLoop,
  type LoopEvent,
  type RunResult,
  type ToolSet,
} from "agent-loop";
import {
  filterValidFields,
  initTask,
  project,
  reduceCommands,
  stageById,
  tryAdvance,
} from "../workflow/reducer";
import type {
  Command,
  EventSource,
  FieldDef,
  Task,
  TaskStatus,
  WorkflowDef,
} from "../workflow/types";
import type {
  ChronicleEntry,
  ChronicleStore,
  EventStore,
  ProjectionStore,
  ProjectStore,
  WorkflowRegistry,
} from "../store/types";
import type { Project } from "../project";
import { buildCommandTools } from "./command-tools";
import { buildIntakeSystem, buildRouteTool, type RouteDecision } from "./intake";
import { buildCommitSystem, buildPrompt, buildSystem, type TeamMember, type ToolCallFact } from "./prompt";

function isTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const DIAGNOSTIC_TEXT_LIMIT = 800;
const TOOL_FACT_LIMIT = 40;
const TOOL_PREVIEW_LIMIT = 600;

interface RunDiagnostics {
  phase: "worker" | "commit";
  eventCount: number;
  toolCallStarts: Record<string, number>;
  toolCallEnds: Record<string, number>;
  toolCallErrors: Record<string, number>;
  textChars: number;
  textPreview: string;
  toolCallFacts: ToolCallFact[];
}

function createRunDiagnostics(phase: RunDiagnostics["phase"]): RunDiagnostics {
  return {
    phase,
    eventCount: 0,
    toolCallStarts: {},
    toolCallEnds: {},
    toolCallErrors: {},
    textChars: 0,
    textPreview: "",
    toolCallFacts: [],
  };
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function appendPreview(existing: string, text: string, limit = DIAGNOSTIC_TEXT_LIMIT): string {
  if (existing.length >= limit) return existing;
  const remaining = limit - existing.length;
  return existing + text.slice(0, remaining);
}

function compactPreview(text: string, limit = DIAGNOSTIC_TEXT_LIMIT): { preview?: string; chars: number; truncated: boolean } {
  const compact = text.trim();
  if (!compact) return { chars: text.length, truncated: false };
  return {
    preview: compact.slice(0, limit),
    chars: text.length,
    truncated: compact.length > limit,
  };
}

function sensitiveFieldName(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("authorization") ||
    normalized.includes("apikey") ||
    normalized.includes("credential")
  );
}

function sanitizePreviewValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[max-depth]";
  if (typeof value === "string") return value.length > 1_000 ? `${value.slice(0, 1_000)}...` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    const out = value.slice(0, 20).map((item) => sanitizePreviewValue(item, depth + 1));
    if (value.length > 20) out.push(`[truncated ${value.length - 20} items]`);
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, 30);
    for (const [key, entryValue] of entries) {
      out[key] = sensitiveFieldName(key) ? "[redacted]" : sanitizePreviewValue(entryValue, depth + 1);
    }
    if (Object.keys(value).length > entries.length) out["[truncated]"] = `${Object.keys(value).length - entries.length} fields`;
    return out;
  }
  if (value === undefined) return undefined;
  return String(value);
}

function compactValuePreview(value: unknown, limit = TOOL_PREVIEW_LIMIT): string | undefined {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(sanitizePreviewValue(value));
  } catch {
    text = String(value);
  }
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function rememberToolFact(diagnostics: RunDiagnostics, fact: ToolCallFact): void {
  if (diagnostics.toolCallFacts.length >= TOOL_FACT_LIMIT) return;
  diagnostics.toolCallFacts.push(fact);
}

function observeLoopEvent(diagnostics: RunDiagnostics, event: LoopEvent): void {
  diagnostics.eventCount++;
  switch (event.type) {
    case "text":
      diagnostics.textChars += event.text.length;
      diagnostics.textPreview = appendPreview(diagnostics.textPreview, event.text);
      break;
    case "tool_call_start":
      incrementCount(diagnostics.toolCallStarts, event.name);
      rememberToolFact(diagnostics, {
        tool: event.name,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(compactValuePreview(event.args) ? { argsPreview: compactValuePreview(event.args) } : {}),
      });
      break;
    case "tool_call_end":
      incrementCount(diagnostics.toolCallEnds, event.name);
      if (event.error) incrementCount(diagnostics.toolCallErrors, event.name);
      rememberToolFact(diagnostics, {
        tool: event.name,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(compactValuePreview(event.result) ? { resultPreview: compactValuePreview(event.result) } : {}),
        ...(event.error ? { error: event.error } : {}),
      });
      break;
  }
}

function finalizeRunDiagnostics(diagnostics: RunDiagnostics, result: RunResult): Record<string, unknown> {
  const text = result.text || diagnostics.textPreview;
  const preview = compactPreview(text);
  return {
    phase: diagnostics.phase,
    status: result.status,
    eventCount: diagnostics.eventCount,
    toolCallStarts: diagnostics.toolCallStarts,
    toolCallEnds: diagnostics.toolCallEnds,
    toolCallErrors: diagnostics.toolCallErrors,
    textChars: result.text ? result.text.length : diagnostics.textChars,
    ...(preview.preview ? { textPreview: preview.preview, textTruncated: preview.truncated } : {}),
    ...(diagnostics.toolCallFacts.length ? { toolCallFacts: diagnostics.toolCallFacts } : {}),
    ...(result.status === "error" ? { error: result.error?.message ?? "unknown error" } : {}),
  };
}

function toolCountsSummary(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}:${count}`);
  return parts.length ? parts.join(", ") : "none";
}

function progressSummary(event: LoopEvent): string | null {
  switch (event.type) {
    case "tool_call_start":
      return `tool ${event.name} started`;
    case "tool_call_end":
      return event.error ? `tool ${event.name} failed` : `tool ${event.name} ended`;
    default:
      return null;
  }
}

function progressData(phase: RunDiagnostics["phase"], event: LoopEvent): Record<string, unknown> | null {
  switch (event.type) {
    case "tool_call_start":
      return {
        phase,
        event: event.type,
        tool: event.name,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(compactValuePreview(event.args) ? { argsPreview: compactValuePreview(event.args) } : {}),
      };
    case "tool_call_end":
      return {
        phase,
        event: event.type,
        tool: event.name,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
        ...(compactValuePreview(event.result) ? { resultPreview: compactValuePreview(event.result) } : {}),
        ...(event.error ? { error: event.error } : {}),
      };
    default:
      return null;
  }
}

function fieldJsonSchema(def: FieldDef | undefined): Record<string, unknown> {
  switch (def?.type) {
    case "string":
    case "ref":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "enum":
      return { type: "string", ...(def.enum ? { enum: [...def.enum] } : {}) };
    case "json":
    default:
      return {};
  }
}

function commitFieldValueValid(def: FieldDef | undefined, value: unknown): boolean {
  switch (def?.type) {
    case "string":
    case "ref":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && !!def.enum?.includes(value);
    case "json":
      return true;
    default:
      return false;
  }
}

function isStageCommitSignal(command: Command, stage: ReturnType<typeof stageById>): boolean {
  switch (command.kind) {
    case "request_transition":
    case "block":
    case "cancel":
    case "create_subtask":
      return true;
    case "set_field":
      return !stage?.outputFields?.length || stage.outputFields.includes(command.field);
    default:
      return false;
  }
}

function closesCurrentRun(command: Command): boolean {
  switch (command.kind) {
    case "request_transition":
    case "block":
    case "cancel":
      return true;
    default:
      return false;
  }
}

/** Task ids become filenames in the durable stores — keep them collision- and traversal-safe. */
function assertValidTaskId(id: string): void {
  if (!id || id === "." || id === ".." || !/^[A-Za-z0-9._-]+$/.test(id))
    throw new Error(`invalid task id "${id}": must match [A-Za-z0-9._-]+ and not be "." or ".."`);
}

/** Context handed to the loop factory so a wake can pick runtime/provider per task. */
export interface WakeContext {
  task: Task;
  workflow: WorkflowDef;
  stageId: string;
  /** The task's project (for cwd/model/env isolation), when a ProjectStore is wired. */
  project?: Project;
}

/** Builds the worker loop for a wake. Lets each wake choose runtime/provider. */
export type LoopFactory = (ctx: WakeContext) => AgentLoop;

/**
 * Resolves the worker's own tools (its "hands") for a wake. This is the worker
 * boundary: coding/file/shell tooling belongs to the agent, not the coordination
 * engine. The engine merges whatever this returns with the wake's command tools
 * without knowing what the tools are. Unset ⇒ the worker runs with command tools
 * only (e.g. a coding-agent runtime that carries its own interface natively).
 */
export type WorkerToolsFactory = (ctx: WakeContext, loop: AgentLoop) => ToolSet | Promise<ToolSet>;

/**
 * Provide an isolated workspace for a task that requested it (`Task.isolate`, ADR
 * 0010). Opaque to the engine — the worker boundary maps it to e.g. a git worktree
 * (or a no-op off git). Returns the effective project the wake should use (e.g.
 * rooted at the worktree), which then drives cwd/allowedPaths/tools.
 */
export type IsolateWorkspace = (ctx: WakeContext, project: Project) => Project | Promise<Project>;

/** Release an isolated task's workspace when it terminates (commit + cleanup). Idempotent. */
export type ReleaseWorkspace = (task: Task, project: Project) => void | Promise<void>;

export interface EngineHooks {
  onWakeStart?(info: { taskId: string; wakeId: string; stageId: string }): void;
  onWakeEnd?(info: {
    taskId: string;
    wakeId: string;
    commands: readonly Command[];
    /** The stage the task ended in, when the wake net-advanced from where it started. */
    advancedTo?: string;
    status: TaskStatus;
    /** Set when the agent run itself failed (result.status === "error"). */
    error?: Error;
  }): void;
  onLoopEvent?(info: { taskId: string; wakeId: string; event: LoopEvent }): void;
  onReject?(info: { taskId: string; wakeId: string; command: Command; reason: string }): void;
  onError?(info: { taskId: string; error: Error }): void;
}

export interface WorkflowEngineOptions {
  events: EventStore;
  projections: ProjectionStore;
  registry: WorkflowRegistry;
  /** Builds the worker loop per wake (e.g. deepseek-v4-flash over claude-code/ai-sdk). */
  loop: LoopFactory;
  /**
   * Supplies the worker's own tools per wake (the worker boundary). Optional: a
   * worker that carries its own interface (a coding-agent runtime) needs none.
   */
  workerTools?: WorkerToolsFactory;
  /** Provide an isolated workspace for `isolate` tasks (ADR 0010); opaque to the engine. */
  isolateWorkspace?: IsolateWorkspace;
  /** Release an isolated task's workspace when it terminates (commit + cleanup). */
  releaseWorkspace?: ReleaseWorkspace;
  /** Builds the intake-router loop (classifies a raw request → workflow). Optional. */
  intakeLoop?: () => AgentLoop;
  hooks?: EngineHooks;
  /** Optional durable observability log of engine/wake activity (read by the CLI). */
  chronicle?: ChronicleStore;
  /** Optional project store: when wired, createTask validates the project exists. */
  projects?: ProjectStore;
  /** Override id generation (default: a deterministic per-engine counter). */
  genId?: (kind: "task" | "wake") => string;
  /**
   * Wall-clock cap per wake. A wake exceeding it is aborted/cancelled and
   * reported as an errored run — so a wedged backend that ignores cancellation
   * can never hang a task. Unset = no timeout (not recommended in production).
   */
  wakeTimeoutMs?: number;
  /** Max wakes per task per engine session (runaway backstop). Default 50. */
  maxWakesPerTask?: number;
}

/**
 * The wake engine (M1): a self-built minimal virtual actor. Each task is a
 * single-writer with a coalescing mailbox — at most one wake runs per task at a
 * time, and signals arriving mid-wake collapse into the next one. A wake:
 * pre-advances on external state, runs ONE bounded agent-loop run for the
 * current stage (with that stage's command tools + the projection as context),
 * applies the agent's commands through the reducer, then post-advances. A wake
 * that moves the task into a new (non-terminal) stage self-schedules the next.
 *
 * The engine is task-agnostic: it coordinates a worker as a black box (assign
 * context + state tools, observe commands, advance by guards). It knows nothing
 * about coding, files, or shells — a worker's own tools arrive via workerTools.
 */
export class WorkflowEngine {
  private readonly state = new Map<string, { running: boolean; pending: boolean; wakes: number }>();
  private readonly inflight = new Set<Promise<void>>();
  /** Isolated tasks whose workspace has already been released (fire releaseWorkspace once). */
  private readonly released = new Set<string>();

  constructor(private readonly o: WorkflowEngineOptions) {}

  private newId(kind: "task" | "wake"): string {
    if (this.o.genId) return this.o.genId(kind);
    // Globally unique (NOT an in-memory counter) so ids minted in a fresh CLI
    // process can't collide with ids already on disk from an earlier invocation.
    return `${kind}_${randomUUID()}`;
  }

  /** Create a task on a workflow (default GENERAL) and schedule its first wake. */
  async createTask(params: {
    projectId: string;
    workflowId?: string;
    taskId?: string;
    fields?: Record<string, unknown>;
    parentId?: string;
    /** The hired worker (model/runtime) for this task; falls back to project/workspace defaults. */
    workerId?: string;
    /** Run this task's wakes in an isolated workspace (ADR 0010); honored at the worker boundary. */
    isolate?: boolean;
    source?: EventSource;
    /** Default true; pass false to create without an initial wake. */
    wake?: boolean;
  }): Promise<Task> {
    const project = this.o.projects ? await this.o.projects.get(params.projectId) : undefined;
    if (this.o.projects && !project) throw new Error(`unknown project "${params.projectId}"`);
    const workflowId = params.workflowId ?? project?.defaultWorkflowId ?? "general";
    const wf = this.o.registry.get(workflowId);
    if (!wf) throw new Error(`unknown workflow "${workflowId}"`);
    const taskId = params.taskId ?? this.newId("task");
    assertValidTaskId(taskId);
    if ((await this.o.events.load(taskId)).length > 0)
      throw new Error(`task ${taskId} already exists`);
    await this.o.events.append(
      taskId,
      initTask({
        taskId,
        projectId: params.projectId,
        workflow: wf,
        ...(params.fields ? { fields: params.fields } : {}),
        ...(params.parentId ? { parentId: params.parentId } : {}),
        ...(params.workerId ? { workerId: params.workerId } : {}),
        ...(params.isolate ? { isolate: true } : {}),
        source: params.source ?? "lead",
      }),
    );
    const task = await this.persist(taskId, wf);
    await this.chron({
      type: "task.created",
      taskId,
      summary: `created on workflow "${wf.id}" (project ${params.projectId})${params.parentId ? ` as child of ${params.parentId}` : ""}`,
      data: { workflowId: wf.id, projectId: params.projectId, ...(params.parentId ? { parentId: params.parentId } : {}) },
    });
    if (params.wake !== false) this.schedule(taskId);
    return task;
  }

  /**
   * Apply a command from outside a wake (e.g. the lead agent sets a field /
   * cancels), then schedule a wake. Requires the task to already exist (await
   * `createTask` first). Unlike a wake's tolerant apply, an illegal command here
   * THROWS `CommandRejectedError` — programmatic callers should fail loud.
   */
  async submitCommand(
    taskId: string,
    command: Command,
    source: EventSource = "lead",
    opts: { schedule?: boolean } = {},
  ): Promise<void> {
    if (command.kind === "create_subtask")
      throw new Error("create_subtask is a worker-only command (the engine mints the child); it can't be submitted directly");
    const { task, wf } = await this.loadPinned(taskId);
    const events = reduceCommands(task, wf, [command], { source });
    if (events.length) {
      await this.o.events.append(taskId, events);
      await this.persist(taskId, wf);
    }
    // The CLI persists with schedule:false and drives wakes separately via `run`.
    if (opts.schedule !== false) this.schedule(taskId);
  }

  /** Drive pending (non-terminal, unblocked) tasks to quiescence — the CLI `run`. */
  async runPending(taskId?: string): Promise<void> {
    if (taskId) {
      this.schedule(taskId);
    } else {
      for (const t of await this.o.projections.query())
        if (t.status === "todo" || t.status === "in_progress") this.schedule(t.id);
    }
    await this.idle();
  }

  /**
   * Route a raw requirement to a workflow via an agent-loop classifier (the
   * intake router) and create the task. Falls back to GENERAL when no intake
   * loop is configured, the agent doesn't decide, or it picks an unknown
   * workflow. Agent-extracted fields are validated against the target schema.
   */
  async intake(
    request: string,
    opts: { projectId: string; taskId?: string; workerId?: string; parentId?: string; wake?: boolean },
  ): Promise<Task> {
    const workflows = this.o.registry.list();
    const decision = await this.routeRequest(request, workflows);
    const routed = decision ? this.o.registry.get(decision.workflowId) : undefined;
    const wf = routed ?? this.o.registry.get("general");
    if (!wf) throw new Error("intake: no target workflow (GENERAL fallback is not registered)");

    const fields = filterValidFields(wf, decision?.fields ?? {});
    if (wf.fields.request && fields.request === undefined) fields.request = request;

    await this.chron({
      type: "intake.routed",
      summary: `routed to "${wf.id}"${routed ? "" : " (fallback)"}: ${request.slice(0, 80)}`,
      data: { workflowId: wf.id, request },
    });

    return this.createTask({
      projectId: opts.projectId,
      workflowId: wf.id,
      fields,
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(opts.workerId ? { workerId: opts.workerId } : {}),
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      ...(opts.wake !== undefined ? { wake: opts.wake } : {}),
    });
  }

  private async routeRequest(request: string, workflows: WorkflowDef[]): Promise<RouteDecision | null> {
    const factory = this.o.intakeLoop;
    if (!factory || workflows.length === 0) return null;
    const loop = factory();
    if (!loop.supports("tools")) return null;
    const { tools, decision } = buildRouteTool(workflows.map((w) => w.id));
    const controller = new AbortController();
    const run = loop.run({
      system: buildIntakeSystem(workflows, request),
      prompt: "Route this request to a workflow using the `route` tool.",
      tools,
      signal: controller.signal,
    });
    const result = await this.boundedRun(run.result, () => {
      controller.abort();
      run.cancel("intake timeout");
    });
    if (result.status === "error") {
      await this.chron({ type: "wake.error", summary: `intake failed: ${result.error?.message ?? "unknown"}` });
      return null;
    }
    return decision();
  }

  /** Nudge a (possibly quiet) task to re-evaluate — the cron/manual entry point. */
  nudge(taskId: string): void {
    this.schedule(taskId);
  }

  getTask(taskId: string): Promise<Task | null> {
    return this.o.projections.get(taskId);
  }

  /** Resolve once no task is running or pending. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  // ---- mailbox: single-writer + coalescing per task ------------------------

  private schedule(taskId: string): void {
    const st = this.state.get(taskId) ?? { running: false, pending: false, wakes: 0 };
    st.pending = true;
    this.state.set(taskId, st);
    if (!st.running) this.kick(taskId);
  }

  private kick(taskId: string): void {
    const st = this.state.get(taskId);
    if (!st || st.running || !st.pending) return;
    // Backstop against a model-driven runaway (e.g. a stage that re-spawns
    // subtasks on every wake): cap wakes per task per engine session.
    const cap = this.o.maxWakesPerTask ?? 50;
    if (st.wakes >= cap) {
      st.pending = false;
      this.o.hooks?.onError?.({ taskId, error: new Error(`wake budget exceeded for ${taskId} (${cap})`) });
      void this.chron({ type: "wake.error", taskId, summary: `wake budget exceeded (${cap}); stopping to prevent a runaway` });
      return;
    }
    st.wakes++;
    st.running = true;
    st.pending = false;
    const p = this.runWake(taskId)
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.o.hooks?.onError?.({ taskId, error });
        // Durably record it too — loadPinned/registry-miss failures throw before
        // any wake chronicle entry, so without this they'd vanish entirely.
        void this.chron({ type: "wake.error", taskId, summary: error.message });
      })
      .finally(() => {
        st.running = false;
        if (st.pending) this.kick(taskId); // a signal arrived mid-wake — drain it
      });
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  // ---- the wake cycle ------------------------------------------------------

  private async runWake(taskId: string): Promise<void> {
    const { wf, task: loaded } = await this.loadPinned(taskId);
    const stageAtStart = loaded.stageId;

    // (1) Pre-advance: external state (a lead's field-set) may already admit the
    // next stage — advance before spending an agent turn.
    let task = await this.advance(taskId, wf, "engine");
    if (isTerminal(task.status) || task.status === "blocked") return;
    const stageAgentRanOn = task.stageId;

    // (2) Run ONE bounded agent wake for the current stage.
    const wakeId = this.newId("wake");
    const stage = stageById(wf, task.stageId);
    let project = this.o.projects ? ((await this.o.projects.get(task.projectId)) ?? undefined) : undefined;
    // Isolated tasks (ADR 0010) run in a workspace the worker boundary provides
    // (e.g. a git worktree). The engine forwards opaquely and uses whatever project
    // it gets back to scope cwd/allowedPaths/tools for this wake.
    if (project && task.isolate && this.o.isolateWorkspace) {
      project = await this.o.isolateWorkspace({ task, workflow: wf, stageId: task.stageId, project }, project);
    }
    const ctx: WakeContext = { task, workflow: wf, stageId: task.stageId, ...(project ? { project } : {}) };
    const loop = this.o.loop(ctx);
    if (!loop.supports("tools"))
      throw new Error(
        `task ${taskId}: worker runtime "${loop.id}" lacks the "tools" capability that command tools require (use claude-code or ai-sdk, not codex/cursor)`,
      );
    const controller = new AbortController();
    let workerRun: ReturnType<AgentLoop["run"]> | undefined;
    let pendingWorkerStop: string | undefined;
    const stopWorkerRun = (reason: string) => {
      if (workerRun) {
        controller.abort(reason);
        workerRun.cancel(reason);
      } else {
        pendingWorkerStop = reason;
      }
    };
    const { tools: commandTools, drain } = buildCommandTools(wf, stage, {
      onCommand: (command) => {
        if (closesCurrentRun(command)) stopWorkerRun(`wakespace ${command.kind} recorded`);
      },
    });
    // The worker brings its own tools (its "hands") from the worker boundary; the
    // engine merges them with the command tools without knowing what they are.
    const workerTools = (await this.o.workerTools?.(ctx, loop)) ?? {};
    const workerToolNames = Object.keys(workerTools);
    const tools = { ...workerTools, ...commandTools };
    this.o.hooks?.onWakeStart?.({ taskId, wakeId, stageId: task.stageId });
    await this.chron({ type: "wake.start", taskId, wakeId, summary: `wake @ "${task.stageId}"` });

    const aiSdkRuntimeOptions =
      loop.id === "ai-sdk"
        ? {
            toolChoice: "required",
            activeTools: Object.keys(tools),
            providerOptions: { deepseek: { thinking: { type: "disabled" } } },
          }
        : undefined;
    const team = await this.teamSnapshots(task);
    const run = loop.run({
      system: buildSystem(task, wf, stage, workerToolNames, project?.memory, team),
      prompt: buildPrompt(task, wf, stage),
      tools,
      signal: controller.signal,
      ...(aiSdkRuntimeOptions ? { runtimeOptions: aiSdkRuntimeOptions } : {}),
    });
    workerRun = run;
    if (pendingWorkerStop) stopWorkerRun(pendingWorkerStop);
    const consumeRun = async (
      runHandle: ReturnType<AgentLoop["run"]>,
      diagnostics: RunDiagnostics,
    ): Promise<RunResult> => {
      for await (const event of runHandle) {
        observeLoopEvent(diagnostics, event);
        this.o.hooks?.onLoopEvent?.({ taskId, wakeId, event });
        const summary = progressSummary(event);
        const data = progressData(diagnostics.phase, event);
        if (summary && data) await this.chron({ type: "wake.progress", taskId, wakeId, summary, data });
      }
      return runHandle.result;
    };
    const workerDiagnostics = createRunDiagnostics("worker");
    let result = await this.boundedRun(consumeRun(run, workerDiagnostics), () => {
      controller.abort();
      run.cancel("wake timeout");
    });
    let commands = drain();
    await this.chron({
      type: "wake.diagnostics",
      taskId,
      wakeId,
      summary: `worker pass: status=${result.status} stateCommands=${commands.length} toolStarts=${toolCountsSummary(workerDiagnostics.toolCallStarts)}`,
      data: {
        ...finalizeRunDiagnostics(workerDiagnostics, result),
        stageId: task.stageId,
        stateCommands: commands.length,
      },
    });

    const hasStageCommitSignal = commands.some((command) => isStageCommitSignal(command, stage));
    if (!hasStageCommitSignal && result.status !== "error") {
      // Commit fallback: the worker pass recorded no durable state (it answered in
      // plain text or only inspected). Re-drive it with a constrained set of state
      // tools so the turn produces an outcome — record stage progress, or block.
      const firstPassText = compactPreview(result.text || workerDiagnostics.textPreview);
      const firstPassCommands = commands;
      const commitCommands: Command[] = [];
      let stageCommitted = false;
      let commitRun: ReturnType<AgentLoop["run"]> | undefined;
      let pendingCommitStop: string | undefined;
      const commitController = new AbortController();
      const stopCommitRun = (reason: string) => {
        if (commitRun) {
          commitController.abort(reason);
          commitRun.cancel(reason);
        } else {
          pendingCommitStop = reason;
        }
      };
      const pushCommit = (command: Command): { acknowledged: true } => {
        if (stageCommitted && (command.kind === "block" || command.kind === "cancel")) return { acknowledged: true };
        if (
          (command.kind === "block" || command.kind === "cancel") &&
          commitCommands.some((existing) => existing.kind === "block" || existing.kind === "cancel")
        )
          return { acknowledged: true };
        commitCommands.push(command);
        if (closesCurrentRun(command)) stopCommitRun(`wakespace ${command.kind} recorded`);
        return { acknowledged: true };
      };
      const allowedFields = (stage?.outputFields?.length ? stage.outputFields : Object.keys(wf.fields)).filter(
        (name) => wf.fields[name],
      );
      const commitTools: ToolSet = {};
      commitTools.commit_stage = defineTool({
        description:
          "Atomically commit this stage's durable workflow fields and request transition if the stage is complete.",
        inputSchema: {
          type: "object",
          properties: {
            fields: {
              type: "object",
              properties: Object.fromEntries(allowedFields.map((field) => [field, fieldJsonSchema(wf.fields[field])])),
              ...(allowedFields.length ? { required: allowedFields } : {}),
              additionalProperties: !stage?.outputFields?.length,
            },
            reason: { type: "string" },
          },
          required: ["fields"],
          additionalProperties: false,
        },
        execute: (args) => {
          const fields = isRecord(args.fields) ? args.fields : {};
          for (const field of allowedFields) {
            if (
              Object.prototype.hasOwnProperty.call(fields, field) &&
              !commitFieldValueValid(wf.fields[field], fields[field])
            ) {
              return {
                error: `field "${field}" must be ${wf.fields[field]?.type ?? "a valid workflow field value"}`,
              };
            }
          }
          commitCommands.length = 0;
          stageCommitted = true;
          for (const field of allowedFields) {
            if (Object.prototype.hasOwnProperty.call(fields, field))
              pushCommit({ kind: "set_field", field, value: fields[field] });
          }
          return pushCommit({
            kind: "request_transition",
            reason: args.reason ? String(args.reason) : "stage committed",
          });
        },
      });
      commitTools.block = defineTool({
        description: "Block the task when it cannot be completed. State the concrete reason.",
        inputSchema: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
          additionalProperties: false,
        },
        execute: (args) => pushCommit({ kind: "block", reason: String(args.reason) }),
      });
      commitTools.cancel = defineTool({
        description:
          "Request cancellation when this task should not be completed at all. Worker requests are audit-only until a lead approves cancellation.",
        inputSchema: {
          type: "object",
          properties: { reason: { type: "string" } },
          additionalProperties: false,
        },
        execute: (args) => pushCommit({ kind: "cancel", ...(args.reason ? { reason: String(args.reason) } : {}) }),
      });
      await this.chron({
        type: "wake.commit",
        taskId,
        wakeId,
        summary: `worker produced no stage commit commands; commit fallback tools: ${Object.keys(commitTools).join(", ")}`,
        data: {
          reason: firstPassCommands.length === 0 ? "no_state_commands" : "no_stage_commit_commands",
          stageId: task.stageId,
          firstPassCommands: firstPassCommands.map((command) => command.kind),
          allowedTools: Object.keys(commitTools),
          ...(stage?.outputFields?.length ? { outputFields: [...stage.outputFields] } : {}),
          ...(workerDiagnostics.toolCallFacts.length ? { toolCallFacts: workerDiagnostics.toolCallFacts } : {}),
          firstPassTextChars: firstPassText.chars,
          ...(firstPassText.preview ? { firstPassTextPreview: firstPassText.preview } : {}),
          firstPassTextTruncated: firstPassText.truncated,
        },
      });
      commitRun = loop.run({
        system: buildCommitSystem(task, wf, stage, result.text, {
          toolCallFacts: workerDiagnostics.toolCallFacts,
        }),
        prompt:
          "Commit durable wakespace progress now. Call `commit_stage` with this stage's output fields if the stage is complete, or `block` with a concrete reason if it cannot be done. Do not answer in plain text.",
        tools: commitTools,
        signal: commitController.signal,
        runtimeOptions:
          loop.id === "ai-sdk"
            ? {
                toolChoice: "required",
                activeTools: Object.keys(commitTools),
                providerOptions: { deepseek: { thinking: { type: "disabled" } } },
              }
            : undefined,
      });
      if (pendingCommitStop) stopCommitRun(pendingCommitStop);
      const commitDiagnostics = createRunDiagnostics("commit");
      result = await this.boundedRun(consumeRun(commitRun, commitDiagnostics), () => {
        commitController.abort();
        commitRun.cancel("wake commit timeout");
      });
      commands = [...firstPassCommands, ...drain(), ...commitCommands];
      await this.chron({
        type: "wake.diagnostics",
        taskId,
        wakeId,
        summary: `commit pass: status=${result.status} stateCommands=${commands.length} toolStarts=${toolCountsSummary(commitDiagnostics.toolCallStarts)}`,
        data: {
          ...finalizeRunDiagnostics(commitDiagnostics, result),
          stageId: task.stageId,
          stateCommands: commands.length,
          allowedTools: Object.keys(commitTools),
        },
      });
    }

    // (3) Apply the agent's commands against the LIVE task (re-loaded so a command
    // that raced in via submitCommand — e.g. a cancel — is respected, and no
    // worker event is ever written after a terminal/blocked one).
    const live = (await this.loadPinned(taskId)).task;
    if (commands.length && !isTerminal(live.status) && live.status !== "blocked") {
      // Spawn child tasks for any create_subtask commands (minting their ids)
      // before the reducer records the subtask.created links. Tolerate a failing
      // spawn per-command — drop it, like reduceCommands' onReject — so one bad
      // subtask can't crash the wake or orphan the children that did spawn.
      const dropped = new Set<Command>();
      for (const command of commands)
        if (command.kind === "create_subtask") {
          try {
            command.childId = await this.spawnSubtask(live, command);
          } catch (err) {
            dropped.add(command);
            const e = err instanceof Error ? err : new Error(String(err));
            this.o.hooks?.onReject?.({ taskId, wakeId, command, reason: e.message });
            void this.chron({ type: "command.rejected", taskId, wakeId, summary: `create_subtask failed: ${e.message}` });
          }
        }
      const toApply = dropped.size ? commands.filter((c) => !dropped.has(c)) : commands;
      const events = reduceCommands(live, wf, toApply, { source: "worker", wakeId }, (command, err) => {
        this.o.hooks?.onReject?.({ taskId, wakeId, command, reason: err.message });
        void this.chron({
          type: "command.rejected",
          taskId,
          wakeId,
          summary: `rejected ${command.kind}: ${err.message}`,
        });
      });
      if (events.length) {
        await this.o.events.append(taskId, events);
        await this.persist(taskId, wf); // re-sync the projection even with no transition
      }
    }

    // (4) Post-advance, then report + self-continue.
    task = await this.advance(taskId, wf, "engine", wakeId);
    const advancedTo = task.stageId !== stageAtStart ? task.stageId : undefined;
    const error =
      result.status === "error"
        ? (result.error ?? new Error("wake run failed"))
        : commands.length === 0
          ? new Error("worker completed without calling any wakespace state tool")
          : undefined;
    this.o.hooks?.onWakeEnd?.({
      taskId,
      wakeId,
      commands,
      ...(advancedTo ? { advancedTo } : {}),
      status: task.status,
      ...(error ? { error } : {}),
    });
    if (error) this.o.hooks?.onError?.({ taskId, error });
    await this.chron({
      type: error ? "wake.error" : "wake.end",
      taskId,
      wakeId,
      summary: error
        ? `wake failed: ${error.message}`
        : `wake done — status=${task.status}${advancedTo ? ` → "${advancedTo}"` : ""} (${commands.length} cmds)`,
      data: {
        status: task.status,
        commands: commands.length,
        ...(advancedTo ? { advancedTo } : {}),
        ...(error ? { error: error.message } : {}),
      },
    });

    // A new, non-terminal stage BEYOND the one the agent ran on means new work.
    // (In-stage iterative progress is by design left for an external nudge in M1.)
    if (task.stageId !== stageAgentRanOn && !isTerminal(task.status)) this.schedule(taskId);
  }

  /**
   * Re-project from the LIVE log and apply as many guard-admitted transitions as
   * possible. Re-loading (rather than trusting a snapshot) keeps the guard env's
   * fields and event-types from one consistent log view, even under concurrent
   * external writes.
   */
  private async advance(
    taskId: string,
    wf: WorkflowDef,
    source: EventSource,
    wakeId?: string,
  ): Promise<Task> {
    const events = await this.o.events.load(taskId);
    const task = project(events, wf);
    if (isTerminal(task.status) || task.status === "blocked") return task;
    const adv = tryAdvance(task, wf, events, {
      source,
      children: await this.resolveChildren(task),
      ...(wakeId ? { wakeId } : {}),
    });
    if (!adv.length) return task;
    await this.o.events.append(taskId, adv);
    const after = await this.persist(taskId, wf);
    // Mirror the transition onto the chronicle so an agent watching the activity
    // stream sees advances/completions — incl. ones driven purely by pre-advance.
    await this.chron({
      type: "task.advanced",
      taskId,
      ...(wakeId ? { wakeId } : {}),
      summary: `advanced "${task.stageId}" → "${after.stageId}"`,
      data: { from: task.stageId, to: after.stageId },
    });
    if (isTerminal(after.status))
      await this.chron({
        type: "task.terminal",
        taskId,
        ...(wakeId ? { wakeId } : {}),
        summary: `task ${after.status} at "${after.stageId}"`,
        data: { status: after.status },
      });
    return after;
  }

  /**
   * Await the wake's run bounded by `wakeTimeoutMs`: on timeout, abort/cancel and
   * return a synthetic errored result so a backend that ignores cancellation can
   * never hang the task (its run is abandoned). Also normalizes a rejected
   * consume into an errored result.
   */
  private async boundedRun(consume: Promise<RunResult>, onTimeout: () => void): Promise<RunResult> {
    const errored = (error: Error): RunResult => ({
      events: [],
      usage: emptyUsage(),
      durationMs: 0,
      status: "error",
      error,
      text: "",
    });
    const safe = consume.catch((err) => errored(err instanceof Error ? err : new Error(String(err))));
    const ms = this.o.wakeTimeoutMs;
    if (!ms) return safe;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<RunResult>((resolve) => {
      timer = setTimeout(() => {
        onTimeout();
        resolve(errored(new Error(`wake timed out after ${ms}ms`)));
      }, ms);
    });
    const result = await Promise.race([safe, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  private async chron(entry: Omit<ChronicleEntry, "seq" | "ts">): Promise<void> {
    if (this.o.chronicle) await this.o.chronicle.append(entry);
  }

  /** Create a child task for a create_subtask command and return its minted id. */
  private async spawnSubtask(
    parent: Task,
    command: { workflowId: string; input: string; isolate?: boolean },
  ): Promise<string> {
    const wf = this.o.registry.get(command.workflowId) ?? this.o.registry.get("general");
    if (!wf)
      throw new Error(`create_subtask: workflow "${command.workflowId}" not registered and no GENERAL fallback`);
    const childId = this.newId("task");
    await this.createTask({
      projectId: parent.projectId,
      workflowId: wf.id,
      ...(wf.fields.request ? { fields: { request: command.input } } : {}),
      ...(parent.workerId ? { workerId: parent.workerId } : {}),
      ...(command.isolate ? { isolate: true } : {}),
      parentId: parent.id,
      taskId: childId,
      source: "engine",
    });
    return childId;
  }

  private async resolveChildren(task: Task): Promise<TaskStatus[]> {
    if (task.childIds.length === 0) return [];
    const kids = await Promise.all(task.childIds.map((id) => this.o.projections.get(id)));
    return kids.flatMap((k) => (k ? [k.status] : []));
  }

  /**
   * Read-only snapshot of a lead's team (its children) for its wake prompt
   * (ADR 0009): id, workflow, status, and the child's summary/request fields so
   * the lead can review and re-plan. Live projection read; not a durable event.
   */
  private async teamSnapshots(task: Task): Promise<TeamMember[]> {
    if (task.childIds.length === 0) return [];
    const kids = await Promise.all(task.childIds.map((id) => this.o.projections.get(id)));
    return kids.flatMap((k) =>
      k
        ? [
            {
              id: k.id,
              workflowId: k.workflowId,
              status: k.status,
              ...(k.isolate ? { isolate: true } : {}),
              ...(typeof k.fields.summary === "string" && k.fields.summary ? { summary: k.fields.summary } : {}),
              ...(typeof k.fields.request === "string" && k.fields.request ? { request: k.fields.request } : {}),
            },
          ]
        : [],
    );
  }

  private async loadPinned(taskId: string): Promise<{ task: Task; wf: WorkflowDef }> {
    const events = await this.o.events.load(taskId);
    const created = events[0];
    if (!created) throw new Error(`no such task: ${taskId}`);
    const workflowId = String(created.payload.workflowId);
    const workflowVersion = String(created.payload.workflowVersion);
    const wf = this.o.registry.get(workflowId, workflowVersion);
    if (!wf) throw new Error(`workflow ${workflowId}@${workflowVersion} is not registered`);
    return { task: project(events, wf), wf };
  }

  private async persist(taskId: string, wf: WorkflowDef): Promise<Task> {
    const task = project(await this.o.events.load(taskId), wf);
    await this.o.projections.put(task);
    if (isTerminal(task.status)) {
      // Release an isolated task's workspace once it terminates (commit + cleanup),
      // exactly once. The worker boundary owns the git/worktree details.
      if (task.isolate && this.o.releaseWorkspace && !this.released.has(taskId)) {
        this.released.add(taskId);
        const proj = this.o.projects ? ((await this.o.projects.get(task.projectId)) ?? undefined) : undefined;
        if (proj) {
          try {
            await this.o.releaseWorkspace(task, proj);
          } catch (err) {
            void this.chron({
              type: "wake.error",
              taskId,
              summary: `releaseWorkspace failed: ${(err as Error).message}`,
            });
          }
        }
      }
      // A finished child re-wakes its parent so a `childrenDone` gate re-evaluates.
      if (task.parentId) this.schedule(task.parentId);
    }
    return task;
  }
}
