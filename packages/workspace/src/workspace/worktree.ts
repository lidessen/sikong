import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { worktreeDir } from "../data-dir";

export interface TaskWorktreeInput {
  dataDir: string;
  workspaceId: string;
  taskId: string;
  repoPath: string;
}

export interface TaskWorktreeAllocation {
  cwd: string;
  repoPath: string;
}

export class WorkspaceWorktreeError extends Error {
  readonly code: "repo_not_git" | "worktree_failed";
  readonly stderr?: string;

  constructor(code: "repo_not_git" | "worktree_failed", message: string, stderr?: string) {
    super(message);
    this.name = "WorkspaceWorktreeError";
    this.code = code;
    this.stderr = stderr;
  }
}

export async function allocateTaskWorktree(
  input: TaskWorktreeInput,
): Promise<TaskWorktreeAllocation> {
  const repoRoot = await resolveGitRepositoryRoot(input.repoPath);
  const cwd = worktreeDir(input.dataDir, input.workspaceId, input.taskId);
  await mkdir(dirname(cwd), { recursive: true });

  const added = await runGit(["-C", repoRoot, "worktree", "add", "--detach", cwd, "HEAD"]);
  if (added.exitCode !== 0) {
    throw new WorkspaceWorktreeError(
      "worktree_failed",
      "Failed to create workspace-owned git worktree.",
      added.stderr,
    );
  }

  return { cwd, repoPath: repoRoot };
}

async function resolveGitRepositoryRoot(repoPath: string): Promise<string> {
  const resolved = await runGit(["-C", repoPath, "rev-parse", "--show-toplevel"]);
  if (resolved.exitCode !== 0) {
    throw new WorkspaceWorktreeError(
      "repo_not_git",
      "Runtime repo path is not a git repository.",
      resolved.stderr,
    );
  }
  return resolved.stdout.trim();
}

async function runGit(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
