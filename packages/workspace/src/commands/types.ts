export type CommandResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: CommandError;
    };

export interface CommandError {
  code: CommandErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type CommandErrorCode =
  | "invalid_input"
  | "workspace_not_found"
  | "workspace_exists"
  | "preference_not_found"
  | "task_not_found"
  | "invalid_state"
  | "timeout"
  | "runtime_cwd_not_found"
  | "runtime_repo_not_found"
  | "runtime_repo_not_git"
  | "runtime_worktree_failed"
  | "daemon_error"
  | "internal_error";

export interface CommandContext {
  dataDir: string;
  workspaceId?: string;
  outputMode?: "json" | "text";
  now?: () => Date;
  id?: () => string;
}

export function ok<T>(data: T): CommandResult<T> {
  return { ok: true, data };
}

export function fail<T = never>(
  code: CommandErrorCode,
  message: string,
  details?: Record<string, unknown>,
): CommandResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

export function commandNow(ctx: CommandContext): string {
  return (ctx.now?.() ?? new Date()).toISOString();
}
