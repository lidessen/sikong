import type { AgentLoop, Hooks, LoopEvent, ToolSet } from "agent-loop";
import type {
  ChronicleStore,
  EventStore,
  ProjectionStore,
  ProjectStore,
  WorkflowRegistry,
} from "../store/types";
import type { Project } from "../project";
import type { AcceptanceCheck, Command, Task, TaskStatus, WorkflowDef } from "../workflow/types";
import type { ScopeLeaseStore } from "./scope-lease";
import type { SteerMailbox } from "./steer-mailbox";

/** Context handed to the loop factory so a wake can pick runtime/provider per task. */
export interface WakeContext {
  task: Task;
  workflow: WorkflowDef;
  stageId: string;
  /** The task's project (for cwd/model/env isolation), when a ProjectStore is wired. */
  project?: Project;
  /**
   * Model tier for this wake. "fast" by default; "strong" once a task's prior
   * wake(s) failed — the worker boundary escalates to a stronger model for the
   * retry (pro is reserved for where the fast model demonstrably struggles).
   */
  modelTier?: "fast" | "strong";
}

/** Builds the worker loop for a wake. Lets each wake choose runtime/provider. */
export type LoopFactory = (ctx: WakeContext) => AgentLoop;

/**
 * Resolves the worker's own tools (its "hands") for a wake. This is the worker
 * boundary: coding/file/shell tooling belongs to the agent, not the coordination
 * engine. The engine merges whatever this returns with the wake's command tools
 * without knowing what the tools are. Unset means the worker runs with command
 * tools only.
 */
export type WorkerToolsFactory = (ctx: WakeContext, loop: AgentLoop) => ToolSet | Promise<ToolSet>;

/**
 * Supplies per-run lifecycle hooks for the worker loop. Used to apply
 * sandbox-escalation policy via `onToolUse`; opaque to the engine.
 */
export type WorkerHooksFactory = (
  ctx: WakeContext,
  loop: AgentLoop,
) => Hooks | undefined | Promise<Hooks | undefined>;

/** What worker a wake hired — recorded with usage so the report can cost it. */
export interface WorkerInfo {
  model?: string;
  provider?: string;
  /** "token" = pay-per-token (priced in $); "subscription" = quota/window-based ($ n/a). */
  billingMode?: "token" | "subscription";
}

/** Describes the worker a wake will hire (model/provider/billing), for usage accounting. */
export type DescribeWorker = (ctx: WakeContext) => WorkerInfo | undefined;

/** Provide an isolated workspace for a task that requested it. */
export type IsolateWorkspace = (ctx: WakeContext, project: Project) => Project | Promise<Project>;

/** Release an isolated task's workspace when it terminates. Idempotent. */
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
   * worker that carries its own interface needs none.
   */
  workerTools?: WorkerToolsFactory;
  /** Supplies per-run worker hooks (the worker boundary). */
  workerHooks?: WorkerHooksFactory;
  /** Optional: describe the worker a wake hires (model/provider/billing) for usage costing. */
  describeWorker?: DescribeWorker;
  /** Provide an isolated workspace for `isolate` tasks; opaque to the engine. */
  isolateWorkspace?: IsolateWorkspace;
  /** Release an isolated task's workspace when it terminates. */
  releaseWorkspace?: ReleaseWorkspace;
  /** Builds the intake-router loop (classifies a raw request -> workflow). Optional. */
  intakeLoop?: () => AgentLoop;
  hooks?: EngineHooks;
  /** Optional durable observability log of engine/wake activity (read by the CLI). */
  chronicle?: ChronicleStore;
  /** Optional cross-process mailbox for lead steer messages while a wake is running. */
  steerMailbox?: SteerMailbox;
  /** Optional workspace-level task scope leases. */
  scopeLeases?: ScopeLeaseStore;
  /** Optional project store: when wired, createTask validates the project exists. */
  projects?: ProjectStore;
  /** Override id generation (default: UUID-backed ids). */
  genId?: (kind: "task" | "wake") => string;
  /** Explicit wall-clock cap per wake. Set 0 only for tests or emergency debugging. */
  wakeTimeoutMs?: number;
  /** Max wakes per task per engine session (runaway backstop). Default 50. */
  maxWakesPerTask?: number;
  /** Errored child-wake retry limit before terminal auto-fail. Default 1. */
  maxWakeRetries?: number;
  /** Default max team depth for workflows that don't set their own cap. */
  maxTeamDepth?: number;
}

export type { AcceptanceCheck };
