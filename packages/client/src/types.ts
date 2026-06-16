export type TaskStatus =
  | "created"
  | "planning"
  | "plan_submitted"
  | "running"
  | "reviewing"
  | "accepted"
  | "rejected"
  | "completed";

export interface Workspace {
  id: string;
  name: string;
  sourceKind?: "git" | "directory" | "empty";
  taskCount?: number;
  activeTaskCount?: number;
}

export interface WorkspacePreference {
  id: string;
  text: string;
  note?: string;
}

export interface TaskCard {
  taskId: string;
  workspaceId: string;
  status: TaskStatus;
  request?: string;
  currentStage?: {
    id: string;
    title: string;
  };
  activeRound?: {
    id: string;
    title?: string;
    intent: string;
    workUnits: number;
    startedWorkUnits: number;
    runningWorkUnits: number;
    completedWorkUnits: number;
  };
  plan?: {
    status?: "requested" | "submitted" | "accepted" | "rejected";
    id?: string;
    version?: number;
    stageCount: number;
  };
  nextAction: {
    type: string;
    [key: string]: unknown;
  };
  waitingForLead: boolean;
  runtimeProcesses: {
    total: number;
    running: number;
  };
  terminal?: {
    outcome: "accepted" | "rejected";
    report?: string;
    at: string;
  };
  latestWorkerResult?: {
    runId: string;
    stageId: string;
    status: "running" | "completed" | "failed" | "budget_exceeded";
    summary?: string;
    finishedAt?: string;
  };
  latestRuntimeProcess?: {
    processRunId: string;
    actionType: string;
    status: string;
    processStatus?: string;
    startedAt: string;
    finishedAt?: string;
  };
  latestReview?: {
    reviewId: string;
    stageId?: string;
    status: string;
    recommendation?: "accept" | "reject";
    report?: string;
    finishedAt?: string;
  };
  updatedAt?: string;
}

export interface ClientWorkLogEntry {
  id: string;
  kind: "task_summary" | "decision" | "user_preference" | "project_status";
  summary: string;
  workspaceId?: string;
  relatedTaskIds?: string[];
  createdAt: string;
}

export interface ClientAgentContextPacket {
  policy: {
    transcript: "query_with_tools";
    workspaceState: "authoritative";
    taskEvents: "inspect_on_demand";
    memory: "none";
  };
  focus: {
    workspaceId?: string;
    taskId?: string;
    source?: "ui" | "message_resolved" | "none";
  };
  currentMessage: ClientAgentCurrentMessage;
  workspaceIndex: ClientAgentWorkspaceIndexEntry[];
  focusedWorkspace?: {
    workspace: Workspace;
    preferences: WorkspacePreference[];
    taskCards: TaskCard[];
  };
  focusedTask?: {
    compact: TaskCard;
  };
  recentTranscript: ClientTranscriptMessage[];
}

export interface ClientAgentCurrentMessage {
  id: string;
  text: string;
  createdAt: string;
}

export interface ClientTranscriptMessage {
  id: string;
  role: ClientMessageRole | string;
  createdAt: string;
  parts?: unknown[];
}

export interface ClientAgentWorkspaceIndexEntry {
  workspaceId: string;
  name: string;
  status?: string;
  activeTaskCount: number;
  updatedAt?: string;
}

export interface ClientState {
  workspaces: Workspace[];
  selectedWorkspaceId?: string;
  taskCards: TaskCard[];
  preferences: WorkspacePreference[];
  workLog: ClientWorkLogEntry[];
  transcript?: ClientMessage[];
  settings: SikongSettings;
  scheduler?: SchedulerStatus;
}

export interface SchedulerStatus {
  enabled: boolean;
  paused?: boolean;
  active?: number;
  maxConcurrent?: number;
  lastScanAt?: string;
  lastTickAt?: string;
  lastError?: string;
  started?: number;
  completed?: number;
  runnableSeen?: number;
  activeTasks?: string[];
  processTimeoutMs?: number;
  waitTimeoutMs?: number;
}

export interface TaskDetailView {
  compact: TaskCard;
  projection: TaskProjectionView;
  trace: TaskTraceEntry[];
  events: TaskEventView[];
  observations: WorkerRunObservationGroup[];
  processRuns?: ProcessRunSnapshotView[];
  processRunError?: string;
}

export interface TaskProjectionView {
  taskId: string;
  workspaceId: string;
  request?: string;
  runtime?: {
    cwd?: string;
    repoPath?: string;
  };
  status: TaskStatus;
  createdAt?: string;
  updatedAt?: string;
  plan?: {
    id: string;
    version: number;
    summary?: string;
    stages: TaskPlanStageView[];
  };
  planDecision?: {
    status: "requested" | "submitted" | "accepted" | "rejected";
    planId?: string;
    version?: number;
    report?: string;
    requestedChanges?: string;
    updatedAt: string;
  };
  currentStageId?: string;
  acceptedStageIds: string[];
  stageRounds: Record<string, TaskStageRoundView>;
  activeRoundId?: string;
  runtimeProcessRuns?: Record<string, RuntimeProcessRunView>;
  workerRuns: Record<string, WorkerRunView>;
  stageReviews: Record<string, StageReviewView>;
  finalReview?: FinalReviewView;
  terminal?: TaskCard["terminal"];
  eventCount: number;
}

export interface TaskPlanStageView {
  id: string;
  title: string;
  objective: string;
  acceptance: string[];
}

export interface TaskStageRoundView {
  id: string;
  stageId: string;
  title?: string;
  intent: string;
  workUnits: TaskStageWorkUnitView[];
  status: "planned" | "completed";
  startedAt?: string;
  completedAt?: string;
}

export interface TaskStageWorkUnitView {
  id: string;
  title: string;
  objective: string;
  acceptance?: string[];
}

export interface WorkerRunView {
  runId: string;
  stageId: string;
  roundId: string;
  workUnitId: string;
  workerId?: string;
  status: "running" | "completed" | "failed" | "budget_exceeded";
  objective?: string;
  result?: {
    summary: string;
    report?: string;
    note?: string;
    observations?: WorkerRunObservation[];
  };
  startedAt?: string;
  finishedAt?: string;
}

export interface RuntimeProcessRunView {
  processRunId: string;
  actionType: string;
  status: "running" | "finished";
  processStatus?: "succeeded" | "failed" | "timed_out" | "cancelled";
  exitCode?: number;
  startedAt: string;
  finishedAt?: string;
}

export interface ProcessRunSnapshotView {
  runId: string;
  workspaceId: string;
  taskId?: string;
  state: "running" | "finished";
  spec: {
    runId: string;
    workspaceId: string;
    taskId?: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    labels?: Record<string, string>;
    stdin?: string;
  };
  result?: {
    runId: string;
    workspaceId: string;
    taskId?: string;
    status: "succeeded" | "failed" | "timed_out" | "cancelled";
    command: string;
    args: string[];
    cwd?: string;
    labels?: Record<string, string>;
    exitCode?: number;
    signal?: string;
    stdout: string;
    stderr: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    timedOut?: boolean;
    cancelled?: boolean;
  };
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface StageReviewView {
  reviewId: string;
  stageId: string;
  status: "started" | "accepted" | "rejected";
  report?: string;
  requestedChanges?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface FinalReviewView {
  reviewId: string;
  status: "started" | "recommended";
  recommendation?: "accept" | "reject";
  report?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TaskTraceEntry {
  eventId: string;
  type: string;
  createdAt: string;
  summary: string;
}

export interface TaskEventView {
  id: string;
  type: string;
  taskId: string;
  workspaceId: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface WorkerRunObservationGroup {
  runId: string;
  stageId: string;
  roundId: string;
  workUnitId: string;
  observations: WorkerRunObservation[];
}

export interface WorkerRunObservation {
  id: string;
  kind:
    | "round_start"
    | "round_end"
    | "thinking"
    | "tool_call"
    | "text"
    | "usage"
    | "step"
    | "error"
    | "hook"
    | "unknown";
  round?: number;
  mode?: "work" | "finish" | "gate";
  at: string;
  summary: string;
  toolName?: string;
  callId?: string;
  status?: "started" | "completed" | "failed";
  argsSummary?: string;
  resultSummary?: string;
  durationMs?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export type ClientTurnOutcomeKind = "report" | "question" | "request";

export interface ClientTurnOutcomeFact {
  label: string;
  value: string;
}

export interface ClientTurnOutcomeRef {
  type: "workspace" | "task" | "transcript" | "other";
  id: string;
}

export interface ClientTurnOutcomeTarget {
  workspaceId?: string;
  taskId?: string;
  planId?: string;
  version?: number;
}

export type ClientTurnOutcome =
  | {
      kind: "report";
      title: string;
      summary: string;
      facts?: ClientTurnOutcomeFact[];
      refs?: ClientTurnOutcomeRef[];
    }
  | {
      kind: "question";
      question: string;
      context?: string;
      options?: string[];
      refs?: ClientTurnOutcomeRef[];
    }
  | {
      kind: "request";
      requestType: "plan_decision" | "final_decision" | "permission" | "clarification" | "other";
      title: string;
      body: string;
      target?: ClientTurnOutcomeTarget;
      refs?: ClientTurnOutcomeRef[];
    };

export type DefaultAgentRuntimeKey = "clientAgent" | "lead" | "worker";

export interface DefaultAgentRuntime {
  backend: string;
  provider?: string;
  model?: string;
}

export interface SikongSettings {
  version: 1;
  defaults: Record<DefaultAgentRuntimeKey, DefaultAgentRuntime>;
}

export type ClientMessageRole = "user" | "assistant" | "system";

export interface ClientMessage {
  id: string;
  role: ClientMessageRole;
  createdAt: string;
  pending?: boolean;
  parts: MessagePart[];
}

export type ClientTurnProgressStatus = "pending" | "running" | "done";

export interface ClientTurnProgressSubstep {
  label: string;
  status: ClientTurnProgressStatus;
}

export interface ClientTurnProgressPhase {
  id: string;
  title: string;
  detail: string;
  status: ClientTurnProgressStatus;
  substeps: ClientTurnProgressSubstep[];
}

export interface ClientTurnProgress {
  title: string;
  detail: string;
  startedAt: string;
  elapsedMs: number;
  phases: ClientTurnProgressPhase[];
}

export type ClientTurnProgressPhaseId = "prepare" | "context" | "agent" | "workspace" | "refresh";

export type TurnStreamEvent =
  | {
      type: "turn.started";
      turnId: string;
      segmentId: string;
      startedAt: string;
      phaseId: ClientTurnProgressPhaseId;
      detail?: string;
    }
  | {
      type: "turn.progress";
      turnId: string;
      segmentId: string;
      phaseId: ClientTurnProgressPhaseId;
      detail?: string;
      at: string;
    }
  | {
      type: "turn.completed";
      turnId: string;
      segmentId: string;
      response: TurnResponse;
      at: string;
    }
  | {
      type: "turn.error";
      turnId: string;
      segmentId: string;
      message: string;
      at: string;
    };

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "progress-card"; progress: ClientTurnProgress }
  | { type: "task-card"; taskId: string }
  | { type: "work-log-summary"; entries: ClientWorkLogEntry[] }
  | { type: "ui"; spec: SikongUISpec };

export interface SikongUISpec {
  root: string;
  elements: Record<string, SikongUIElement>;
}

export interface SikongUIElement {
  type: SikongUIElementType;
  props?: unknown;
  children?: string[];
}

export type SikongUIElementType =
  | "Text"
  | "Heading"
  | "Badge"
  | "Alert"
  | "CodeBlock"
  | "KeyValueList"
  | "Timeline"
  | "Stack"
  | "Inline"
  | "Section"
  | "Card"
  | "Collapsible"
  | "WorkspaceSummary"
  | "TaskSummary"
  | "TaskList"
  | "PlanStageList"
  | "ReviewResult"
  | "RuntimeProcessList"
  | "WorkLogList";

export type SikongUIAction =
  | { type: "focusWorkspace"; workspaceId: string }
  | { type: "focusTask"; taskId: string }
  | { type: "sendMessage"; text: string }
  | { type: "copyText"; text: string };

export interface TurnResponse {
  text: string;
  status: "completed" | "cancelled" | "error";
  context: ClientAgentContextPacket;
  outcome?: ClientTurnOutcome;
  message?: ClientMessage;
}
