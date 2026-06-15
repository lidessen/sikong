import { randomUUID } from "node:crypto";
import {
  type AgentLoop,
  type EffortLevel,
  type LoopEvent,
  type RunHandle,
  type RunResult,
  type TokenUsage,
} from "agent-loop";
import {
  deriveAcceptanceReason,
  deriveAcceptanceStatus,
  eventTypesInCurrentStage,
  filterValidFields,
  initTask,
  project,
  reduceCommands,
  stageById,
  tryAdvance,
} from "../workflow/reducer";
import type {
  AcceptanceCheck,
  Command,
  EventSource,
  Task,
  TaskStatus,
  WorkflowDef,
} from "../workflow/types";
import type { ChronicleEntry } from "../store/types";
import { estimateWakeTimeout, type WakeTimeoutEstimate } from "./adaptive-timeout";
import { buildCommandTools } from "./command-tools";
import { buildIntakeSystem, buildRouteTool, type RouteDecision } from "./intake";
import { buildPrompt, buildSystem } from "./prompt";
import { boundedRun, cleanupRun, INTAKE_TIMEOUT_MS } from "./run-boundary";
import { ScopeLeaseScheduler } from "./scope-scheduler";
import type { TeamMember } from "./team-status";
import type { WakeContext, WorkflowEngineOptions } from "./types";
import {
  compactPreview,
  createRunDiagnostics,
  finalizeRunDiagnostics,
  observeLoopEvent,
  progressData,
  progressSummary,
  runDiagnosticStatus,
  timeoutData,
  toolCountsSummary,
  type RunDiagnostics,
} from "./wake-diagnostics";
import {
  ackedLeadMessageIds,
  assertValidTaskId,
  closesCurrentRun,
  isStageCommitSignal,
  stopReasonFromEvent,
  summarizeLeadMessage,
} from "./wake-signals";

export type {
  DescribeWorker,
  EngineHooks,
  IsolateWorkspace,
  LoopFactory,
  ReleaseWorkspace,
  WakeContext,
  WorkerHooksFactory,
  WorkerInfo,
  WorkerToolsFactory,
  WorkflowEngineOptions,
} from "./types";

function isTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled";
}

const STEER_POLL_MS = 1_000;

interface StateEntry {
  running: boolean;
  pending: boolean;
  wakes: number;
  errors: number;
  stopWake?: (reason: string) => void;
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
  private readonly state = new Map<string, StateEntry>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly scopeScheduler?: ScopeLeaseScheduler;
  /** Isolated tasks whose workspace has already been released (fire releaseWorkspace once). */
  private readonly released = new Set<string>();

  constructor(private readonly o: WorkflowEngineOptions) {
    this.scopeScheduler = o.scopeLeases ? new ScopeLeaseScheduler(o.scopeLeases) : undefined;
  }

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
    /** Depth in the team tree — computed from parent.depth + 1 when spawning subtasks. */
    depth?: number;
    /** The hired worker (model/runtime) for this task; falls back to project/workspace defaults. */
    workerId?: string;
    /** Reasoning-effort override for this task, set by a parent's create_subtask({ effort }). */
    effort?: string;
    /** Lead-authored per-task acceptance criteria (ADR 0027); worker evidence must address these before lead review. */
    acceptance?: readonly AcceptanceCheck[];
    /** Run this task's wakes in an isolated workspace (ADR 0010); honored at the worker boundary. */
    isolate?: boolean;
    /** Task ids this task must wait for before it runs (ADR 0011). */
    dependsOn?: readonly string[];
    /** Declared task scopes used by the scheduler to decide wake overlap (ADR 0037). */
    scopes?: Task["scopes"];
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
        ...(params.depth !== undefined ? { depth: params.depth } : {}),
        ...(params.workerId ? { workerId: params.workerId } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        ...(params.isolate ? { isolate: true } : {}),
        ...(params.dependsOn && params.dependsOn.length ? { dependsOn: params.dependsOn } : {}),
        ...(params.scopes ? { scopes: params.scopes } : {}),
        ...(params.acceptance?.length ? { acceptance: params.acceptance } : {}),
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
      if (command.kind !== "steer") await this.persist(taskId, wf);
      if ((source === "lead" || source === "engine") && (command.kind === "cancel" || command.kind === "block")) {
        const reason = command.kind === "block" ? command.reason : (command.reason ?? "cancel requested");
        this.state.get(taskId)?.stopWake?.(`sikong ${command.kind}: ${reason}`);
      }
    }
    // The CLI persists with schedule:false and drives wakes separately via `run`.
    if (command.kind !== "steer" && opts.schedule !== false) this.schedule(taskId);
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
    opts: {
      projectId: string;
      taskId?: string;
      workerId?: string;
      parentId?: string;
      wake?: boolean;
      acceptance?: readonly AcceptanceCheck[];
      scopes?: Task["scopes"];
    },
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
      ...(opts.scopes ? { scopes: opts.scopes } : {}),
      ...(opts.acceptance?.length ? { acceptance: opts.acceptance } : {}),
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
    const result = await boundedRun(run.result, this.o.wakeTimeoutMs ?? INTAKE_TIMEOUT_MS, async () => {
      controller.abort();
      return cleanupRun(run, "intake timeout");
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

  /** Check for tasks waiting on scope leases that can now run. Returns task ids to nudge. */
  scopeWaiters(): Promise<string[]> {
    return this.scopeScheduler?.checkWaiters() ?? Promise.resolve([]);
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
    const st = this.state.get(taskId) ?? { running: false, pending: false, wakes: 0, errors: 0 };
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
      void this.chron({ type: "wake.error", taskId, summary: `wake budget exceeded (${cap}); failing the task` });
      void this.failTask(taskId, `wake budget exceeded (${cap})`).catch(() => {});
      return;
    }
    st.wakes++;
    st.running = true;
    st.pending = false;
    const p = this.runWake(taskId)
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.o.hooks?.onError?.({ taskId, error });
        void this.chron({ type: "wake.error", taskId, summary: error.message });
      })
      .finally(() => {
        st.running = false;
        if (st.pending) this.kick(taskId); // a signal arrived mid-wake — drain it
      });
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private setStopWake(taskId: string, stopWake: (reason: string) => void): void {
    const st = this.state.get(taskId);
    if (st) st.stopWake = stopWake;
  }

  private clearStopWake(taskId: string, stopWake: (reason: string) => void): void {
    const st = this.state.get(taskId);
    if (st?.stopWake === stopWake) delete st.stopWake;
  }

  // ---- the wake cycle ------------------------------------------------------

  private async runWake(taskId: string): Promise<void> {
    const { wf, task: loaded } = await this.loadPinned(taskId);
    const stageAtStart = loaded.stageId;

    // (0) Dependency gate (ADR 0011): don't run until every dependency is terminal.
    // A dependent is normally only scheduled once ready, but `run`/`nudge` can
    // schedule everything — defer here, and don't charge the wake budget for a
    // wake that never ran. scheduleReadyDependents re-schedules it when deps finish.
    if (!isTerminal(loaded.status) && loaded.dependsOn?.length && !(await this.depsTerminal(loaded.dependsOn))) {
      const st = this.state.get(taskId);
      if (st) st.wakes = Math.max(0, st.wakes - 1);
      return;
    }

    // (1) Pre-advance: external state (a lead's field-set) may already admit the
    // next stage — advance before spending an agent turn.
    let task = await this.advance(taskId, wf, "engine");
    if (isTerminal(task.status) || task.status === "blocked") return;
    const stageAgentRanOn = task.stageId;

    // (2) Run ONE bounded agent wake for the current stage.
    const wakeId = this.newId("wake");
    const stage = stageById(wf, task.stageId);
    let leasesAcquired = false;
    if (this.scopeScheduler) {
      const acquired = await this.scopeScheduler.acquire(task, wf, wakeId);
      if (!acquired.acquired) {
        const st = this.state.get(taskId);
        if (st) st.wakes = Math.max(0, st.wakes - 1);
        await this.chron({
          type: "wake.waiting",
          taskId,
          wakeId,
          summary: acquired.summary,
          data: acquired.data,
        });
        return;
      }
      leasesAcquired = true;
      this.scopeScheduler?.startRefresh(taskId, wakeId);
    }
    try {
    let project = this.o.projects ? ((await this.o.projects.get(task.projectId)) ?? undefined) : undefined;
    // Isolated tasks (ADR 0010) run in a workspace the worker boundary provides
    // (e.g. a git worktree). The engine forwards opaquely and uses whatever project
    // it gets back to scope cwd/allowedPaths/tools for this wake.
    if (project && task.isolate && this.o.isolateWorkspace) {
      project = await this.o.isolateWorkspace({ task, workflow: wf, stageId: task.stageId, project }, project);
    }
    // Build wake context with the task, workflow, stage and project.
    const ctx: WakeContext = {
      task,
      workflow: wf,
      stageId: task.stageId,
      ...(project ? { project } : {}),
    };
    const workerInfo = this.o.describeWorker?.(ctx);
    const loop = await this.o.loop(ctx);
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
        if (closesCurrentRun(command)) stopWorkerRun(`sikong ${command.kind} recorded`);
      },
    });
    // The worker brings its own tools (its "hands") from the worker boundary; the
    // engine merges them with the command tools without knowing what they are.
    const workerTools = (await this.o.workerTools?.(ctx, loop)) ?? {};
    const workerToolNames = Object.keys(workerTools);
    const commandToolNames = Object.keys(commandTools);
    const tools = { ...workerTools, ...commandTools };
    const workerHooks = (await this.o.workerHooks?.(ctx, loop)) ?? undefined;
    this.o.hooks?.onWakeStart?.({ taskId, wakeId, stageId: task.stageId });

    const aiSdkRuntimeOptions =
      loop.id === "ai-sdk"
        ? {
            toolChoice: "required",
            activeTools: Object.keys(tools),
            providerOptions: { deepseek: { thinking: { type: "disabled" } } },
          }
        : undefined;
    const team = await this.teamSnapshots(task);
    const taskEventsForPrompt = await this.o.events.load(task.id);
    const steerFromSeq = taskEventsForPrompt.at(-1)?.seq ?? 0;
    const pendingLeadMessages = await this.o.steerMailbox?.list(taskId) ?? [];
    const leadStatus = {
      eventTypes: eventTypesInCurrentStage(taskEventsForPrompt),
      acceptanceStatus: deriveAcceptanceStatus(stage, taskEventsForPrompt),
      acceptanceReason: deriveAcceptanceReason(taskEventsForPrompt),
    };
    // Resolve effort per-wake: task override > stage default > workspace default.
    const effort: EffortLevel | undefined = (task.effort ?? stage?.effort ?? "medium") as EffortLevel | undefined;
    const timeout = this.resolveWakeTimeout({
      task,
      workflow: wf,
      stage,
      workerToolNames,
      commandToolNames,
      team,
      projectMemory: project?.memory,
      effort,
      model: workerInfo?.model,
    });
    const workerSteerStartedAt = Date.now();
    await this.chron({
      type: "wake.start",
      taskId,
      wakeId,
      summary: `wake @ "${task.stageId}" — timeout=${Math.round(timeout.timeoutMs / 1000)}s`,
      data: timeoutData(timeout),
    });
    if (pendingLeadMessages.length) {
      await this.chron({
        type: "lead.message",
        taskId,
        wakeId,
        summary: `${pendingLeadMessages.length} pending operator message(s) for lead review`,
        data: { messages: pendingLeadMessages.map(summarizeLeadMessage) },
      });
    }
    this.setStopWake(taskId, stopWorkerRun);
    const run = loop.run({
      system: buildSystem(task, wf, stage, workerToolNames, project?.memory),
      prompt: buildPrompt(task, wf, stage, team, leadStatus, pendingLeadMessages),
      tools,
      signal: controller.signal,
      effort,
      ...(workerHooks ? { hooks: workerHooks } : {}),
      ...(aiSdkRuntimeOptions ? { runtimeOptions: aiSdkRuntimeOptions } : {}),
    });
    workerRun = run;
    if (pendingWorkerStop) stopWorkerRun(pendingWorkerStop);
    const stopWorkerSteerPump = this.startSteerPump(taskId, wakeId, run, steerFromSeq, workerSteerStartedAt, stopWorkerRun);
    let recordingWorkerEvents = true;
    const consumeRun = async (
      runHandle: ReturnType<AgentLoop["run"]>,
      diagnostics: RunDiagnostics,
      shouldRecord: () => boolean,
    ): Promise<RunResult> => {
      for await (const event of runHandle) {
        if (!shouldRecord()) continue;
        observeLoopEvent(diagnostics, event);
        this.o.hooks?.onLoopEvent?.({ taskId, wakeId, event });
        const summary = progressSummary(event);
        const data = progressData(diagnostics.phase, event);
        if (summary && data) await this.chron({ type: "wake.progress", taskId, wakeId, summary, data });
      }
      return runHandle.result;
    };
    const workerDiagnostics = createRunDiagnostics("worker");
    let result: RunResult;
    try {
      result = await boundedRun(
        consumeRun(run, workerDiagnostics, () => recordingWorkerEvents),
        timeout.timeoutMs,
        async () => {
          recordingWorkerEvents = false;
          controller.abort();
          return cleanupRun(run, "wake timeout");
        },
        (cleanup) => {
          return this.chron({
            type: "wake.cleanup",
            taskId,
            wakeId,
            summary:
              cleanup.status === "unsettled"
                ? `worker cleanup unsettled after ${cleanup.reason ?? "timeout"}`
                : `worker cleanup ${cleanup.status} after ${cleanup.reason ?? "timeout"}`,
            data: cleanup as unknown as Record<string, unknown>,
          });
        },
      );
    } finally {
      stopWorkerSteerPump();
      this.clearStopWake(taskId, stopWorkerRun);
    }
    let wakeUsage: TokenUsage = result.usage;
    let commands = drain();
    const ackedMessageIds = ackedLeadMessageIds(commands);
    const workerDiagnosticStatus = runDiagnosticStatus(result, commands);
    await this.chron({
      type: "wake.diagnostics",
      taskId,
      wakeId,
      summary: `worker pass: status=${workerDiagnosticStatus} stateCommands=${commands.length} toolStarts=${toolCountsSummary(workerDiagnostics.toolCallStarts)}`,
      data: {
        ...finalizeRunDiagnostics(workerDiagnostics, result, commands),
        stageId: task.stageId,
        stateCommands: commands.length,
        ...(wakeUsage.cacheReadTokens !== undefined || wakeUsage.cacheCreationTokens !== undefined
          ? { cache: { readTokens: wakeUsage.cacheReadTokens ?? 0, creationTokens: wakeUsage.cacheCreationTokens ?? 0 } }
          : {}),
      },
    });

    const hasStageCommitSignal = commands.some((command) => isStageCommitSignal(command, stage));
    if (!hasStageCommitSignal && result.status !== "error") {
      const liveBeforeCommit = (await this.loadPinned(taskId)).task;
      if (isTerminal(liveBeforeCommit.status) || liveBeforeCommit.status === "blocked") {
        commands = [];
      } else {
        const firstPassText = compactPreview(result.text || workerDiagnostics.textPreview);
        await this.chron({
          type: "wake.review_required",
          taskId,
          wakeId,
          summary: "worker pass ended without durable stage state; lead/reviewer must inspect the work log",
          data: {
            reason: commands.length === 0 ? "no_state_commands" : "no_stage_commit_commands",
            stageId: task.stageId,
            commandKinds: commands.map((command) => command.kind),
            ...(stage?.outputFields?.length ? { outputFields: [...stage.outputFields] } : {}),
            ...(workerDiagnostics.toolCallFacts.length ? { toolCallFacts: workerDiagnostics.toolCallFacts } : {}),
            firstPassTextChars: firstPassText.chars,
            ...(firstPassText.preview ? { firstPassTextPreview: firstPassText.preview } : {}),
            firstPassTextTruncated: firstPassText.truncated,
          },
        });
      }
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
      // Mint ALL child ids first so siblings' `dependsOn` keys can resolve to ids
      // within this batch (ADR 0011), then create each child in declared order.
      const dropped = new Set<Command>();
      const subtaskCmds = commands.filter((c): c is Extract<Command, { kind: "create_subtask" }> => c.kind === "create_subtask");
      const unackedLeadMessages = pendingLeadMessages.filter((entry) => !ackedMessageIds.has(entry.id));
      if (unackedLeadMessages.length && subtaskCmds.length) {
        for (const command of subtaskCmds) {
          dropped.add(command);
          this.o.hooks?.onReject?.({
            taskId,
            wakeId,
            command,
            reason: "pending operator messages require ack_lead_messages before creating subtasks",
          });
        }
        await this.chron({
          type: "command.rejected",
          taskId,
          wakeId,
          summary: `create_subtask requires lead message acknowledgement (${unackedLeadMessages.length} pending)`,
          data: { pendingMessageIds: unackedLeadMessages.map((entry) => entry.id) },
        });
      }
      // Idempotency by (parent, key): re-running the delegate stage (the lead is
      // re-woken on each child completion while childrenDone is unmet) must NOT
      // re-spawn. Seed key→id from already-spawned children so a keyed subtask is
      // created once, and a later subtask's dependsOn can resolve a prior sibling.
      const keyToId = new Map<string, string>();
      for (const e of await this.o.events.load(taskId)) {
        if (e.type === "subtask.created" && typeof e.payload.key === "string" && typeof e.payload.childId === "string")
          keyToId.set(e.payload.key, e.payload.childId);
      }
      for (const c of subtaskCmds) if (c.key && keyToId.has(c.key)) dropped.add(c); // already spawned → no-op
      for (const c of subtaskCmds) {
        if (dropped.has(c)) continue;
        c.childId = this.newId("task");
        if (c.key) keyToId.set(c.key, c.childId);
      }
      for (const command of subtaskCmds) {
        if (dropped.has(command)) continue;
        const deps = (command.dependsOn ?? []).flatMap((k) => {
          const id = keyToId.get(k);
          return id ? [id] : []; // unknown/forward keys are ignored, not a hard error
        });
        try {
          await this.spawnSubtask(live, command, deps);
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
      for (const id of ackedMessageIds) await this.o.steerMailbox?.remove(taskId, id);
    }

    // (4) Post-advance, then report + self-continue.
    task = await this.advance(taskId, wf, "engine", wakeId);
    const advancedTo = task.stageId !== stageAtStart ? task.stageId : undefined;
    const error = result.status === "error" ? (result.error ?? new Error("wake run failed")) : undefined;
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
        timeout: timeoutData(timeout),
        usage: {
          inputTokens: wakeUsage.inputTokens,
          outputTokens: wakeUsage.outputTokens,
          totalTokens: wakeUsage.totalTokens,
          ...(wakeUsage.cacheReadTokens !== undefined ? { cacheReadTokens: wakeUsage.cacheReadTokens } : {}),
          ...(wakeUsage.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: wakeUsage.cacheCreationTokens }
            : {}),
          ...(workerInfo?.model ? { model: workerInfo.model } : {}),
          ...(workerInfo?.provider ? { provider: workerInfo.provider } : {}),
          ...(workerInfo?.billingMode ? { billingMode: workerInfo.billingMode } : {}),
        },
      },
    });

    // Staleness circuit-breaker (ADR 0010): a CHILD whose wake itself FAILED (timeout
    // / run error) must not stay stuck forever wedging its parent's childrenDone.
    // Retry a bounded number of times, then terminally fail it so the parent unblocks
    // and can re-decide (the failed child shows as cancelled with the reason). Root
    // tasks keep the plain behaviour (error reported, left in_progress for re-run) —
    // nothing waits on them.
    const wakeState = this.state.get(taskId);
    if (result.status === "error" && task.parentId && !isTerminal(task.status) && task.status !== "blocked") {
      const errs = wakeState ? (wakeState.errors += 1) : 1;
      if (errs <= (this.o.maxWakeRetries ?? 1)) this.schedule(taskId);
      else await this.failTask(taskId, `auto-failed after ${errs} errored wakes: ${error?.message ?? "wake error"}`, wakeId);
      return;
    }
    if (wakeState) wakeState.errors = 0;

    // A new, non-terminal stage BEYOND the one the agent ran on means new work.
    // (In-stage iterative progress is by design left for an external nudge in M1.)
    if (task.stageId !== stageAgentRanOn && !isTerminal(task.status)) this.schedule(taskId);
    } finally {
      if (leasesAcquired) {
        this.scopeScheduler?.stopRefresh(taskId);
        const waiters = await this.scopeScheduler?.release(taskId, wakeId).catch(() => []);
        for (const id of waiters ?? []) this.schedule(id);
      }
    }
  }

  /**
   * Terminally fail a wedged task (engine-sourced cancel → terminal task.cancelled),
   * so dependents (e.g. a parent's childrenDone) can resolve and re-decide. Idempotent.
   */
  private async failTask(taskId: string, reason: string, wakeId?: string): Promise<void> {
    const { task: live, wf } = await this.loadPinned(taskId);
    if (isTerminal(live.status)) return;
    const events = reduceCommands(live, wf, [{ kind: "cancel", reason }], {
      source: "engine",
      ...(wakeId ? { wakeId } : {}),
    });
    if (!events.length) return;
    await this.o.events.append(taskId, events);
    await this.persist(taskId, wf);
    await this.chron({ type: "wake.error", taskId, ...(wakeId ? { wakeId } : {}), summary: `task auto-failed: ${reason}` });
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
  private resolveWakeTimeout(input: Parameters<typeof estimateWakeTimeout>[0]): WakeTimeoutEstimate {
    if (this.o.wakeTimeoutMs !== undefined) {
      return {
        timeoutMs: this.o.wakeTimeoutMs,
        rawMs: this.o.wakeTimeoutMs,
        minMs: this.o.wakeTimeoutMs,
        maxMs: this.o.wakeTimeoutMs,
        effort: input.effort ?? input.task.effort ?? input.stage?.effort ?? "medium",
        components: [{ name: "explicitOverride", ms: this.o.wakeTimeoutMs }],
      };
    }
    return estimateWakeTimeout(input);
  }

  private startSteerPump(
    taskId: string,
    wakeId: string,
    run: RunHandle,
    fromSeq: number,
    startedAt: number,
    stopRun?: (reason: string) => void,
  ): () => void {
    let cursor = fromSeq;
    let stopped = false;
    let polling = false;
    let stopRequested = false;
    const deliveredMailboxIds = new Set<string>();

    const applySteer = async (
      message: string,
      data: Record<string, unknown>,
      recordTimelineEvent: boolean,
    ): Promise<void> => {
      const outcome = await run.steer(message);
      if (recordTimelineEvent) {
        const [event] = await this.o.events.append(taskId, [
          {
            taskId,
            source: "lead",
            type: "steer.requested",
            payload: { message },
            wakeId,
          },
        ]);
        if (event) cursor = Math.max(cursor, event.seq);
      }
      await this.chron({
        type: "wake.steer",
        taskId,
        wakeId,
        summary: `steer ${outcome.mode}: ${message.slice(0, 100)}`,
        data: { ...data, mode: outcome.mode, message },
      });
    };

    const poll = async (): Promise<void> => {
      if (stopped || polling) return;
      polling = true;
      try {
        const events = (await this.o.events.load(taskId, cursor)).sort((a, b) => a.seq - b.seq || a.ts - b.ts);
        for (const event of events) {
          if (stopped) break;
          cursor = Math.max(cursor, event.seq);
          const stopReason = stopReasonFromEvent(event);
          if (stopReason && !stopRequested) {
            stopRequested = true;
            stopRun?.(stopReason);
            await this.chron({
              type: "wake.error",
              taskId,
              wakeId,
              summary: `wake preempted by ${event.type}`,
              data: { eventSeq: event.seq, source: event.source, reason: stopReason },
            });
            continue;
          }
          if (event.type !== "steer.requested") continue;
          const message = typeof event.payload.message === "string" ? event.payload.message.trim() : "";
          if (!message) continue;
          await applySteer(message, { eventSeq: event.seq }, false);
        }

        for (const entry of await this.o.steerMailbox?.list(taskId) ?? []) {
          if (stopped) break;
          if (entry.createdAt < startedAt || deliveredMailboxIds.has(entry.id)) continue;
          deliveredMailboxIds.add(entry.id);
          const message = entry.message.trim();
          if (!message) continue;
          if (entry.kind === "stop_requested" && !stopRequested) {
            stopRequested = true;
            stopRun?.(`operator stop requested: ${message}`);
            await this.chron({
              type: "wake.error",
              taskId,
              wakeId,
              summary: "wake stopped for operator lead review request",
              data: { mailboxId: entry.id, kind: entry.kind, createdAt: entry.createdAt, message },
            });
            continue;
          }
          await applySteer(message, { mailboxId: entry.id, kind: entry.kind, createdAt: entry.createdAt }, entry.kind === "steer");
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        await this.chron({ type: "wake.error", taskId, wakeId, summary: `steer pump failed: ${error.message}` });
      } finally {
        polling = false;
      }
    };

    const timer = setInterval(() => void poll(), STEER_POLL_MS);
    void poll();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private async chron(entry: Omit<ChronicleEntry, "seq" | "ts">): Promise<void> {
    if (this.o.chronicle) await this.o.chronicle.append(entry);
  }

  /** Create a child task for a create_subtask command and return its minted id. */
  private async spawnSubtask(
    parent: Task,
    command: {
      childId: string;
      workflowId: string;
      input: string;
      isolate?: boolean;
      effort?: string;
      acceptance?: readonly AcceptanceCheck[];
      readScopes?: readonly string[];
      writeScopes?: readonly string[];
    },
    deps: readonly string[],
  ): Promise<void> {
    const wf = this.o.registry.get(command.workflowId) ?? this.o.registry.get("general");
    if (!wf)
      throw new Error(`create_subtask: workflow "${command.workflowId}" not registered and no GENERAL fallback`);
    // Enforce depth cap BEFORE creating the child, so the child is never stranded
    // as an orphan. The effective cap is the more restrictive of the engine-level
    // maxTeamDepth and the parent's workflow-level cap (ADR 0020).
    const parentWf = this.o.registry.get(parent.workflowId, parent.workflowVersion);
    const engineCap = this.o.maxTeamDepth;
    const wfCap = parentWf?.maxTeamDepth;
    const effectiveCap =
      engineCap !== undefined && wfCap !== undefined
        ? Math.min(engineCap, wfCap)
        : (engineCap ?? wfCap);
    if (effectiveCap !== undefined && parent.depth >= effectiveCap)
      throw new Error(
        `max team depth (${effectiveCap}) reached — task "${parent.id}" is at depth ${parent.depth} and cannot create more subtasks`,
      );
    await this.createTask({
      projectId: parent.projectId,
      workflowId: wf.id,
      taskId: command.childId, // pre-minted by the batch so siblings' dependsOn could resolve
      ...(wf.fields.request ? { fields: { request: command.input } } : {}),
      ...(parent.workerId ? { workerId: parent.workerId } : {}),
      ...(command.effort ? { effort: command.effort } : {}),
      depth: parent.depth + 1,
      ...(command.isolate ? { isolate: true } : {}),
      ...(deps.length ? { dependsOn: deps } : {}),
      ...(command.readScopes?.length || command.writeScopes?.length
        ? {
            scopes: {
              ...(command.readScopes?.length ? { read: command.readScopes } : {}),
              ...(command.writeScopes?.length ? { write: command.writeScopes } : {}),
            },
          }
        : {}),
      ...(command.acceptance?.length ? { acceptance: command.acceptance } : {}),
      parentId: parent.id,
      // A child with unmet dependencies is created un-scheduled (ADR 0011); it is
      // scheduled when its last dependency terminates (scheduleReadyDependents).
      ...(deps.length ? { wake: false } : {}),
      source: "engine",
    });
  }

  private async resolveChildren(task: Task): Promise<TaskStatus[]> {
    if (task.childIds.length === 0) return [];
    // Re-project from the event log for each child rather than relying on the
    // cached projection, which may be stale under concurrent writes.
    const kids = await Promise.all(
      task.childIds.map(async (id) => {
        const events = await this.o.events.load(id);
        if (events.length === 0) return null;
        const createdPayload = events[0]?.payload as Record<string, unknown> | undefined;
        const wfId = String(createdPayload?.workflowId ?? "");
        const wfVer = String(createdPayload?.workflowVersion ?? "");
        const wf = this.o.registry.get(wfId, wfVer);
        if (!wf) return null;
        try {
          return project(events, wf);
        } catch {
          return null;
        }
      }),
    );
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
              stageId: k.stageId,
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
      // …and re-wakes any task that was waiting on this one (ADR 0011), once all of
      // that dependent's dependencies are terminal. Same completion path as above.
      await this.scheduleReadyDependents(taskId);
    }
    return task;
  }

  /** True once every dependency task is terminal (a missing dep is treated as satisfied). */
  private async depsTerminal(depIds: readonly string[]): Promise<boolean> {
    for (const id of depIds) {
      const dep = await this.o.projections.get(id);
      if (dep && !isTerminal(dep.status)) return false;
    }
    return true;
  }

  /** Schedule tasks waiting on `doneId` whose dependencies are now all terminal (ADR 0011). */
  private async scheduleReadyDependents(doneId: string): Promise<void> {
    for (const t of await this.o.projections.query()) {
      if (!t.dependsOn?.includes(doneId) || isTerminal(t.status)) continue;
      if (await this.depsTerminal(t.dependsOn)) this.schedule(t.id);
    }
  }
}
