import { randomUUID } from "node:crypto";
import {
  createProjectTools,
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
import { buildCommitSystem, buildPrompt, buildSystem } from "./prompt";

function isTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const PROJECT_WRITE_TOOL_NAMES = new Set(["writeFile", "replaceInFile"]);
const DIAGNOSTIC_TEXT_LIMIT = 800;

interface RunDiagnostics {
  phase: "worker" | "commit";
  eventCount: number;
  toolCallStarts: Record<string, number>;
  toolCallEnds: Record<string, number>;
  toolCallErrors: Record<string, number>;
  textChars: number;
  textPreview: string;
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

function observeLoopEvent(diagnostics: RunDiagnostics, event: LoopEvent): void {
  diagnostics.eventCount++;
  switch (event.type) {
    case "text":
      diagnostics.textChars += event.text.length;
      diagnostics.textPreview = appendPreview(diagnostics.textPreview, event.text);
      break;
    case "tool_call_start":
      incrementCount(diagnostics.toolCallStarts, event.name);
      break;
    case "tool_call_end":
      incrementCount(diagnostics.toolCallEnds, event.name);
      if (event.error) incrementCount(diagnostics.toolCallErrors, event.name);
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
    ...(result.status === "error" ? { error: result.error?.message ?? "unknown error" } : {}),
  };
}

function toolCountsSummary(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}:${count}`);
  return parts.length ? parts.join(", ") : "none";
}

function toolResultSucceeded(result: unknown): boolean {
  return !(isRecord(result) && typeof result.error === "string" && result.error.length > 0);
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
  /** Builds the intake-router loop (classifies a raw request → workflow). Optional. */
  intakeLoop?: () => AgentLoop;
  hooks?: EngineHooks;
  /** Optional durable observability log of engine/wake activity (read by the CLI). */
  chronicle?: ChronicleStore;
  /** Optional project store: when wired, createTask validates the project exists. */
  projects?: ProjectStore;
  /** Override id generation (default: a deterministic per-engine counter). */
  genId?: (kind: "task" | "wake") => string;
  /** Soft per-wake step cap passed to the loop. */
  maxStepsPerWake?: number;
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
 */
export class WorkflowEngine {
  private readonly state = new Map<string, { running: boolean; pending: boolean; wakes: number }>();
  private readonly inflight = new Set<Promise<void>>();

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
    opts: { projectId: string; taskId?: string; workerId?: string; wake?: boolean },
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
      ...(this.o.maxStepsPerWake ? { maxSteps: this.o.maxStepsPerWake } : {}),
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
    const project = this.o.projects ? ((await this.o.projects.get(task.projectId)) ?? undefined) : undefined;
    const loop = this.o.loop({ task, workflow: wf, stageId: task.stageId, ...(project ? { project } : {}) });
    if (!loop.supports("tools"))
      throw new Error(
        `task ${taskId}: worker runtime "${loop.id}" lacks the "tools" capability that command tools require (use claude-code or ai-sdk, not codex/cursor)`,
      );
    const { tools: commandTools, drain } = buildCommandTools(wf, stage);
    const rawProjectTools =
      loop.id === "ai-sdk" && project?.root
        ? await createProjectTools({ cwd: project.root, ...(project.env ? { env: project.env } : {}) })
        : {};
    let projectToolCalls = 0;
    let projectWriteCalls = 0;
    const projectWriteRequired = stage?.requiresProjectWrite === true;
    const projectTools: ToolSet = {};
    for (const [name, tool] of Object.entries(rawProjectTools)) {
      projectTools[name] = tool.execute
        ? {
            ...tool,
            execute: async (args, ctx) => {
              projectToolCalls++;
              const out = await tool.execute!(args, ctx);
              if (PROJECT_WRITE_TOOL_NAMES.has(name) && toolResultSucceeded(out)) projectWriteCalls++;
              return out;
            },
          }
        : tool;
    }
    const tools = { ...projectTools, ...commandTools };
    this.o.hooks?.onWakeStart?.({ taskId, wakeId, stageId: task.stageId });
    await this.chron({ type: "wake.start", taskId, wakeId, summary: `wake @ "${task.stageId}"` });

    const controller = new AbortController();
    const aiSdkRuntimeOptions =
      loop.id === "ai-sdk"
        ? {
            toolChoice: "required",
            activeTools: Object.keys(tools),
            providerOptions: { deepseek: { thinking: { type: "disabled" } } },
          }
        : undefined;
    const run = loop.run({
      system: buildSystem(task, wf, stage, Object.keys(projectTools), project?.memory),
      prompt: buildPrompt(task, wf, stage),
      tools,
      signal: controller.signal,
      ...(this.o.maxStepsPerWake ? { maxSteps: this.o.maxStepsPerWake } : {}),
      ...(aiSdkRuntimeOptions ? { runtimeOptions: aiSdkRuntimeOptions } : {}),
    });
    const consumeRun = async (
      runHandle: ReturnType<AgentLoop["run"]>,
      diagnostics: RunDiagnostics,
    ): Promise<RunResult> => {
      for await (const event of runHandle) {
        observeLoopEvent(diagnostics, event);
        this.o.hooks?.onLoopEvent?.({ taskId, wakeId, event });
      }
      return runHandle.result;
    };
    const workerDiagnostics = createRunDiagnostics("worker");
    let result = await this.boundedRun(consumeRun(run, workerDiagnostics), () => {
      controller.abort();
      run.cancel("wake timeout");
    });
    let commands = drain();
    const workerDiagnosticData = {
      ...finalizeRunDiagnostics(workerDiagnostics, result),
      stageId: task.stageId,
      stateCommands: commands.length,
      projectToolCalls,
      projectWriteCalls,
      projectWriteRequired,
    };
    await this.chron({
      type: "wake.diagnostics",
      taskId,
      wakeId,
      summary: `worker pass: status=${result.status} stateCommands=${commands.length} projectTools=${projectToolCalls} projectWrites=${projectWriteCalls} toolStarts=${toolCountsSummary(workerDiagnostics.toolCallStarts)}`,
      data: workerDiagnosticData,
    });

    const hasStageCommitSignal = commands.some((command) => isStageCommitSignal(command, stage));
    if (!hasStageCommitSignal && result.status !== "error") {
      const firstPassText = compactPreview(result.text || workerDiagnostics.textPreview);
      const firstPassCommands = commands;
      const commitCommands: Command[] = [];
      let stageCommitted = false;
      const pushCommit = (command: Command): { acknowledged: true } => {
        if (stageCommitted && (command.kind === "block" || command.kind === "cancel")) return { acknowledged: true };
        if (
          (command.kind === "block" || command.kind === "cancel") &&
          commitCommands.some((existing) => existing.kind === "block" || existing.kind === "cancel")
        )
          return { acknowledged: true };
        commitCommands.push(command);
        return { acknowledged: true };
      };
      const canCommitStageProgress = !projectWriteRequired || projectWriteCalls > 0;
      const commitTools: ToolSet = {};
      if (canCommitStageProgress) {
        const allowedFields = (stage?.outputFields?.length ? stage.outputFields : Object.keys(wf.fields)).filter(
          (name) => wf.fields[name],
        );
        commitTools.commit_stage = defineTool({
          description:
            "Atomically commit this stage's durable workflow fields and request transition if the stage is complete.",
          inputSchema: {
            type: "object",
            properties: {
              fields: {
                type: "object",
                properties: Object.fromEntries(allowedFields.map((field) => [field, {}])),
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
      } else {
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
      }
      await this.chron({
        type: "wake.commit",
        taskId,
        wakeId,
        summary: `worker produced no stage commit commands; commit fallback tools: ${Object.keys(commitTools).join(", ")}`,
        data: {
          reason: firstPassCommands.length === 0 ? "no_state_commands" : "no_stage_commit_commands",
          fallbackPolicy: canCommitStageProgress ? "state_commit_allowed" : "project_write_required_without_write",
          stageId: task.stageId,
          firstPassCommands: firstPassCommands.map((command) => command.kind),
          allowedTools: Object.keys(commitTools),
          projectToolCalls,
          projectWriteCalls,
          projectWriteRequired,
          ...(stage?.outputFields?.length ? { outputFields: [...stage.outputFields] } : {}),
          firstPassTextChars: firstPassText.chars,
          ...(firstPassText.preview ? { firstPassTextPreview: firstPassText.preview } : {}),
          firstPassTextTruncated: firstPassText.truncated,
        },
      });
      const commitController = new AbortController();
      const commitPrompt =
        canCommitStageProgress
          ? "Commit durable wakespace progress now. Call `commit_stage` with this stage's output fields if the stage is complete. Block only if progress is impossible. Do not answer in plain text."
          : "Commit durable wakespace progress now. This stage requires project write evidence, but no successful project write tool call was observed, so call `block` with a concrete reason. Do not answer in plain text.";
      const commitRun = loop.run({
        system: buildCommitSystem(task, wf, stage, result.text, {
          projectToolCalls,
          projectWriteCalls,
          projectWriteRequired,
        }),
        prompt: commitPrompt,
        tools: commitTools,
        signal: commitController.signal,
        maxSteps: 2,
        runtimeOptions:
          loop.id === "ai-sdk"
            ? {
                toolChoice: "required",
                activeTools: Object.keys(commitTools),
                providerOptions: { deepseek: { thinking: { type: "disabled" } } },
              }
            : undefined,
      });
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
  private async spawnSubtask(parent: Task, command: { workflowId: string; input: string }): Promise<string> {
    const wf = this.o.registry.get(command.workflowId) ?? this.o.registry.get("general");
    if (!wf)
      throw new Error(`create_subtask: workflow "${command.workflowId}" not registered and no GENERAL fallback`);
    const childId = this.newId("task");
    await this.createTask({
      projectId: parent.projectId,
      workflowId: wf.id,
      ...(wf.fields.request ? { fields: { request: command.input } } : {}),
      ...(parent.workerId ? { workerId: parent.workerId } : {}),
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
    // A finished child re-wakes its parent so a `childrenDone` gate re-evaluates.
    if (isTerminal(task.status) && task.parentId) this.schedule(task.parentId);
    return task;
  }
}
