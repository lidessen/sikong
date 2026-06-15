import {
  inspectTaskCompact,
  listTasks,
  listWorkspacePreferences,
  listWorkspaces,
  type CommandContext,
  type TaskCompactView,
} from "../commands";
import type { WorkspacePreference, WorkspaceDef } from "../workspace";

export interface ClientAgentFocus {
  workspaceId?: string;
  taskId?: string;
  source?: "ui" | "message_resolved" | "none";
}

export interface ClientAgentCurrentMessage {
  id: string;
  text: string;
  createdAt: string;
}

export interface ClientTranscriptMessage {
  id: string;
  role: string;
  createdAt: string;
  parts?: unknown[];
}

export interface ClientTranscriptSource {
  listRecent(options?: { limit?: number }): Promise<ClientTranscriptMessage[]>;
  search(options: { query: string; limit?: number }): Promise<ClientTranscriptMessage[]>;
  getRange(options: {
    beforeMessageId?: string;
    limit?: number;
  }): Promise<ClientTranscriptMessage[]>;
}

export interface ClientAgentWorkspaceIndexEntry {
  workspaceId: string;
  name: string;
  status?: string;
  activeTaskCount: number;
  updatedAt?: string;
}

export interface ClientAgentContextOptions {
  ctx: CommandContext;
  currentMessage: ClientAgentCurrentMessage;
  focus?: ClientAgentFocus;
  transcript?: ClientTranscriptSource;
  recentTranscriptLimit?: number;
}

export interface ClientAgentContextPacket {
  policy: {
    transcript: "query_with_tools";
    workspaceState: "authoritative";
    taskEvents: "inspect_on_demand";
    memory: "none";
  };
  focus: ClientAgentFocus;
  currentMessage: ClientAgentCurrentMessage;
  workspaceIndex: ClientAgentWorkspaceIndexEntry[];
  focusedWorkspace?: {
    workspace: WorkspaceDef;
    preferences: WorkspacePreference[];
    taskCards: TaskCompactView[];
  };
  focusedTask?: {
    compact: TaskCompactView;
  };
  recentTranscript: ClientTranscriptMessage[];
}

export async function buildClientAgentContext(
  options: ClientAgentContextOptions,
): Promise<ClientAgentContextPacket> {
  const transcript = options.transcript ?? emptyTranscriptSource();
  const [recentTranscript, workspacesResult] = await Promise.all([
    transcript.listRecent({ limit: options.recentTranscriptLimit ?? 12 }),
    listWorkspaces(options.ctx),
  ]);
  const workspaces = workspacesResult.ok ? workspacesResult.data.workspaces : [];
  const workspaceId = options.focus?.workspaceId ?? options.ctx.workspaceId ?? workspaces[0]?.id;
  const focus: ClientAgentFocus = {
    ...(workspaceId ? { workspaceId } : {}),
    ...(options.focus?.taskId ? { taskId: options.focus.taskId } : {}),
    source:
      options.focus?.source ??
      (options.focus?.workspaceId || options.focus?.taskId || options.ctx.workspaceId
        ? "ui"
        : "none"),
  };

  const packet: ClientAgentContextPacket = {
    policy: {
      transcript: "query_with_tools",
      workspaceState: "authoritative",
      taskEvents: "inspect_on_demand",
      memory: "none",
    },
    currentMessage: options.currentMessage,
    focus,
    workspaceIndex: await buildWorkspaceIndex(options.ctx, workspaces),
    recentTranscript,
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
    const compact = await inspectTaskCompact(options.ctx, {
      workspaceId,
      taskId: options.focus.taskId,
    });
    if (compact.ok) {
      packet.focusedTask = {
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
      currentMessage: packet.currentMessage,
      focus: packet.focus,
      workspaceIndex: packet.workspaceIndex,
      focusedWorkspace: packet.focusedWorkspace,
      focusedTask: packet.focusedTask,
      recentTranscript: packet.recentTranscript,
    },
    null,
    2,
  );
}

async function buildWorkspaceIndex(
  ctx: CommandContext,
  workspaces: WorkspaceDef[],
): Promise<ClientAgentWorkspaceIndexEntry[]> {
  return await Promise.all(
    workspaces.map(async (workspace) => {
      const tasks = await listTasks(ctx, { workspaceId: workspace.id });
      const taskCards = tasks.ok ? tasks.data.tasks : [];
      const activeTaskCount = taskCards.filter((task) => !task.terminal).length;
      const updatedAt = taskCards
        .map((task) => task.updatedAt)
        .filter((value): value is string => typeof value === "string")
        .sort()
        .at(-1);
      return {
        workspaceId: workspace.id,
        name: workspace.name,
        activeTaskCount,
        ...(updatedAt ? { updatedAt } : {}),
      };
    }),
  );
}

function emptyTranscriptSource(): ClientTranscriptSource {
  return {
    listRecent: async () => [],
    search: async () => [],
    getRange: async () => [],
  };
}
