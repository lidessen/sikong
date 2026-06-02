import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/**
 * Git-worktree isolation for sikong (ADR 0010). This is the ONLY place that
 * knows about git: it backs the worker-boundary `isolateWorkspace`/`releaseWorkspace`
 * hooks. Worktrees live UNDER the sikong home dir (`<dir>/worktrees/<taskId>`),
 * never inside the project checkout, so the project's working tree stays clean and
 * cleanup is scoped to one directory. A task's work lands on branch
 * `sikong/<taskId>` for the lead to integrate.
 */

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}
/** Run a git command, swallowing any error (best-effort cleanup paths). */
async function gitQuiet(cwd: string, args: string[]): Promise<void> {
  try {
    await git(cwd, args);
  } catch {
    /* best-effort */
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const out = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export function worktreeBase(dir: string): string {
  return join(dir, "worktrees");
}
function worktreePath(dir: string, taskId: string): string {
  return join(worktreeBase(dir), taskId);
}
function branchName(taskId: string): string {
  return `sikong/${taskId}`;
}

// `git worktree add` takes a repo lock; serialize concurrent adds per repo root so
// two children waking at once can't collide on the index/worktree lock.
const addLocks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = addLocks.get(root) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  addLocks.set(
    root,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Ensure an isolated worktree exists for `taskId` and return its path. Idempotent:
 * reuses the worktree across the task's wakes. Creates branch `sikong/<taskId>`
 * off the project's current HEAD on first use.
 */
export async function ensureWorktree(dir: string, root: string, taskId: string): Promise<string> {
  const wt = worktreePath(dir, taskId);
  if (await exists(wt)) return wt;
  return withRepoLock(root, async () => {
    if (await exists(wt)) return wt; // re-check inside the lock
    await mkdir(dirname(wt), { recursive: true });
    const branch = branchName(taskId);
    const hasBranch = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
      () => true,
      () => false,
    );
    if (hasBranch) await git(root, ["worktree", "add", wt, branch]);
    else await git(root, ["worktree", "add", "-b", branch, wt, "HEAD"]);
    return wt;
  });
}

/**
 * Release a task's worktree when it terminates. On `done`, commit the work to its
 * branch (so the lead can merge it), then remove the worktree directory but keep
 * the branch. On `cancelled`, drop both. Always prunes git's worktree admin refs.
 * Idempotent + best-effort (safe to call when already removed).
 */
export async function releaseWorktree(
  dir: string,
  root: string,
  taskId: string,
  status: string,
): Promise<void> {
  const wt = worktreePath(dir, taskId);
  const branch = branchName(taskId);
  if (status === "done" && (await exists(wt))) {
    await gitQuiet(wt, ["add", "-A"]);
    const clean = await git(wt, ["diff", "--cached", "--quiet"]).then(
      () => true,
      () => false,
    );
    if (!clean) await gitQuiet(wt, ["commit", "--no-verify", "-m", `sikong subtask ${taskId}`]);
  }
  if (await exists(wt)) await gitQuiet(root, ["worktree", "remove", "--force", wt]);
  await rm(wt, { recursive: true, force: true }).catch(() => {});
  if (status === "cancelled") await gitQuiet(root, ["branch", "-D", branch]);
  await gitQuiet(root, ["worktree", "prune"]);
}

/**
/**
 * Which tasks' isolation artifacts (worktree + branch) must be RETAINED: every
 * live task, PLUS every task whose parent is still live. The second clause is
 * essential (ADR 0010 fix): a child may finish before its parent (the lead) has
 * integrated its branch — reclaiming on child-terminal alone would destroy the
 * branch the lead still needs to merge. Keep it until the parent effort is done.
 */
export function retainedTaskIds(
  tasks: readonly { id: string; status: string; parentId?: string }[],
): Set<string> {
  const isLive = (s: string) => s === "todo" || s === "in_progress" || s === "blocked";
  const live = new Set<string>();
  for (const t of tasks) if (isLive(t.status)) live.add(t.id);
  const retain = new Set(live);
  for (const t of tasks) if (t.parentId && live.has(t.parentId)) retain.add(t.id);
  return retain;
}

/**
 * Garbage-collect leftover worktrees AND branches: remove any worktree directory
 * and `sikong/<id>` branch whose task id is NOT in `retainTaskIds` (see
 * retainedTaskIds), prune git's admin refs. Cleanup is keyed on task lifecycle —
 * not git's merged-detection — and preserves a child's branch until its parent
 * effort terminates. Safe to call any time; bounds worktree/branch accumulation.
 */
export async function gcWorktrees(
  dir: string,
  roots: readonly string[],
  retainTaskIds: ReadonlySet<string>,
): Promise<void> {
  const base = worktreeBase(dir);
  let names: string[] = [];
  try {
    names = await readdir(base);
  } catch {
    /* no worktrees dir yet — nothing to GC except branch prune below */
  }
  for (const name of names) {
    if (!retainTaskIds.has(name)) await rm(join(base, name), { recursive: true, force: true }).catch(() => {});
  }
  for (const root of roots) {
    if (!(await isGitRepo(root))) continue;
    await gitQuiet(root, ["worktree", "prune"]); // drops admin refs for removed worktrees, so branches aren't "checked out"
    const out = await git(root, ["branch", "--list", "sikong/*", "--format=%(refname:short)"]).catch(() => "");
    for (const b of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (!retainTaskIds.has(b.slice("sikong/".length))) await gitQuiet(root, ["branch", "-D", b]);
    }
  }
}
