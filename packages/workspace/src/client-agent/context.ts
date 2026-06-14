import {
  inspectTaskCompact,
  inspectTaskSummary,
  listTasks,
  listWorkspacePreferences,
  listWorkspaces,
  type CommandContext,
  type TaskCompactView,
  type TaskSummary,
} from "../commands";
import type { WorkspacePreference, WorkspaceDef } from "../workspace";
import { FileClientWorkLog, type ClientWorkLog, type ClientWorkLogEntry } from "./work-log";

export interface ClientAgentFocus {
  workspaceId?: string;
  taskId?: string;
}

export interface ClientAgentContextOptions {
  ctx: CommandContext;
  focus?: ClientAgentFocus;
  workLog?: ClientWorkLog;
  workLogLimit?: number;
}

export interface ClientAgentContextPacket {
  policy: {
    transcript: "presentation_only";
    memory: "client_work_log";
    taskEvents: "detail_only";
  };
  focus: ClientAgentFocus;
  workLog: ClientWorkLogEntry[];
  workspaces: WorkspaceDef[];
  focusedWorkspace?: {
    workspace: WorkspaceDef;
    preferences: WorkspacePreference[];
    taskCards: TaskCompactView[];
  };
  focusedTask?: {
    summary: TaskSummary;
    compact: TaskCompactView;
  };
}

export async function buildClientAgentContext(
  options: ClientAgentContextOptions,
): Promise<ClientAgentContextPacket> {
  const workLog = options.workLog ?? new FileClientWorkLog(options.ctx.dataDir);
  const [workLogEntries, workspacesResult] = await Promise.all([
    workLog.list({ limit: options.workLogLimit ?? 40 }),
    listWorkspaces(options.ctx),
  ]);
  const workspaces = workspacesResult.ok ? workspacesResult.data.workspaces : [];
  const workspaceId = options.focus?.workspaceId ?? options.ctx.workspaceId ?? workspaces[0]?.id;
  const focus: ClientAgentFocus = {
    ...(workspaceId ? { workspaceId } : {}),
    ...(options.focus?.taskId ? { taskId: options.focus.taskId } : {}),
  };

  const packet: ClientAgentContextPacket = {
    policy: {
      transcript: "presentation_only",
      memory: "client_work_log",
      taskEvents: "detail_only",
    },
    focus,
    workLog: workLogEntries,
    workspaces,
  };

  if (!workspaceId) return packet;

  const [preferencesResult, tasksResult] = await Promise.all([
    listWorkspacePreferences(options.ctx, { workspaceId }),
    listTasks(options.ctx, { workspaceId }),
  ]);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (workspace) {
    packet.focusedWorkspace = {
      workspace,
      preferences: preferencesResult.ok ? preferencesResult.data.preferences : [],
      taskCards: tasksResult.ok ? tasksResult.data.tasks : [],
    };
  }

  if (options.focus?.taskId) {
    const [summary, compact] = await Promise.all([
      inspectTaskSummary(options.ctx, { workspaceId, taskId: options.focus.taskId }),
      inspectTaskCompact(options.ctx, { workspaceId, taskId: options.focus.taskId }),
    ]);
    if (summary.ok && compact.ok) {
      packet.focusedTask = {
        summary: summary.data.summary,
        compact: compact.data.compact,
      };
    }
  }

  return packet;
}

export function formatClientAgentContext(packet: ClientAgentContextPacket): string {
  return JSON.stringify(
    {
      policy: packet.policy,
      focus: packet.focus,
      workLog: packet.workLog,
      workspaces: packet.workspaces,
      focusedWorkspace: packet.focusedWorkspace,
      focusedTask: packet.focusedTask,
    },
    null,
    2,
  );
}
