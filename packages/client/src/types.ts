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
    transcript: "presentation_only";
    memory: "client_work_log";
    taskEvents: "detail_only";
  };
  focus: {
    workspaceId?: string;
    taskId?: string;
  };
  workLog: ClientWorkLogEntry[];
  workspaces: Workspace[];
}

export interface ClientState {
  workspaces: Workspace[];
  selectedWorkspaceId?: string;
  taskCards: TaskCard[];
  preferences: WorkspacePreference[];
  workLog: ClientWorkLogEntry[];
  transcript?: ClientMessage[];
  settings: SikongSettings;
}

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
  message?: ClientMessage;
}
