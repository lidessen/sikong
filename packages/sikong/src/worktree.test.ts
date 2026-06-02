import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureWorktree, gcWorktrees, isGitRepo, releaseWorktree, retainedTaskIds } from "./worktree";

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) => exec("git", args, { cwd });
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wt-repo-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "Tester"]);
  await writeFile(join(root, "README.md"), "# repo\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "init"]);
  return root;
}
const cleanup = (...paths: string[]) => Promise.all(paths.map((p) => rm(p, { recursive: true, force: true })));

describe("retainedTaskIds (ADR 0010 fix #4)", () => {
  test("keeps a finished child's artifacts until its parent effort terminates", () => {
    // lead live, one child done, one child in_progress, plus an orphan done task
    const retain = retainedTaskIds([
      { id: "lead", status: "in_progress" },
      { id: "childDone", status: "done", parentId: "lead" },
      { id: "childRunning", status: "in_progress", parentId: "lead" },
      { id: "orphanDone", status: "done" },
    ]);
    expect(retain.has("lead")).toBe(true); // live
    expect(retain.has("childRunning")).toBe(true); // live
    expect(retain.has("childDone")).toBe(true); // done BUT parent still live → keep its branch for the lead to merge
    expect(retain.has("orphanDone")).toBe(false); // terminal, no live parent → reclaimable
  });

  test("reclaims a finished child once its parent is also terminal", () => {
    const retain = retainedTaskIds([
      { id: "lead", status: "done" },
      { id: "child", status: "done", parentId: "lead" },
    ]);
    expect(retain.has("child")).toBe(false); // both terminal → reclaim
    expect(retain.has("lead")).toBe(false);
  });
});

describe("worktree isolation (ADR 0010)", () => {
  test("isGitRepo distinguishes git from non-git", async () => {
    const root = await initRepo();
    const plain = await mkdtemp(join(tmpdir(), "wt-plain-"));
    try {
      expect(await isGitRepo(root)).toBe(true);
      expect(await isGitRepo(plain)).toBe(false);
    } finally {
      await cleanup(root, plain);
    }
  });

  test("ensure → edit → release(done) commits to the branch and removes the worktree", async () => {
    const root = await initRepo();
    const dir = await mkdtemp(join(tmpdir(), "wt-home-"));
    try {
      const wt = await ensureWorktree(dir, root, "task_a");
      expect(await exists(wt)).toBe(true);
      expect((await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("sikong/task_a");
      expect(await ensureWorktree(dir, root, "task_a")).toBe(wt); // idempotent

      await writeFile(join(wt, "greet.ts"), "export const x = 1;\n"); // the worker's edit
      await releaseWorktree(dir, root, "task_a", "done");

      expect(await exists(wt)).toBe(false); // worktree removed
      expect((await git(root, ["log", "--oneline", "sikong/task_a"])).stdout).toContain("sikong subtask task_a");
      expect((await git(root, ["ls-tree", "--name-only", "sikong/task_a"])).stdout).toContain("greet.ts");
    } finally {
      await cleanup(root, dir);
    }
  });

  test("release(cancelled) drops the worktree and its branch", async () => {
    const root = await initRepo();
    const dir = await mkdtemp(join(tmpdir(), "wt-home-"));
    try {
      const wt = await ensureWorktree(dir, root, "task_c");
      await writeFile(join(wt, "scratch.ts"), "x\n");
      await releaseWorktree(dir, root, "task_c", "cancelled");
      expect(await exists(wt)).toBe(false);
      expect((await git(root, ["branch", "--list", "sikong/task_c"])).stdout.trim()).toBe("");
    } finally {
      await cleanup(root, dir);
    }
  });

  test("gcWorktrees removes worktrees whose task is not live, keeps live ones", async () => {
    const root = await initRepo();
    const dir = await mkdtemp(join(tmpdir(), "wt-home-"));
    try {
      const liveWt = await ensureWorktree(dir, root, "task_live");
      const deadWt = await ensureWorktree(dir, root, "task_dead");
      await gcWorktrees(dir, [root], new Set(["task_live"]));
      expect(await exists(liveWt)).toBe(true); // kept (still live)
      expect(await exists(deadWt)).toBe(false); // reclaimed (not live)
      // branches are cleaned by task liveness, not git-merge detection
      expect((await git(root, ["branch", "--list", "sikong/task_dead"])).stdout.trim()).toBe("");
      expect((await git(root, ["branch", "--list", "sikong/task_live"])).stdout).toContain("sikong/task_live");
    } finally {
      await cleanup(root, dir);
    }
  });
});
