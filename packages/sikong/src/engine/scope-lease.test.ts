import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  JsonScopeLeaseStore,
  effectiveTaskScopeLeases,
  scopeLeasesConflict,
  type ActiveScopeLease,
} from "./scope-lease";
import type { Task, WorkflowDef } from "../workflow/types";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-scope-lease-"));

function lease(partial: Partial<ActiveScopeLease>): ActiveScopeLease {
  return {
    taskId: "t",
    wakeId: "w",
    projectId: "p",
    mode: "write",
    scope: "package:packages/ui",
    acquiredAt: 1,
    expiresAt: Date.now() + 60_000,
    ...partial,
  };
}

const baseTask: Task = {
  id: "t",
  projectId: "p",
  workflowId: "wf",
  workflowVersion: "1",
  stageId: "open",
  fields: {},
  status: "in_progress",
  childIds: [],
  depth: 0,
  cursor: 0,
  createdAt: 1,
  updatedAt: 1,
};

const codingWorkflow: WorkflowDef = {
  id: "wf",
  version: "1",
  name: "WF",
  description: "workflow",
  workerRole: "coding",
  fields: {},
  stages: [
    { id: "open", category: "in_progress", entry: { op: "always" } },
    { id: "done", category: "done", entry: { op: "always" } },
  ],
};

describe("scope leases", () => {
  test("defaults coding tasks to a project write lease", () => {
    expect(effectiveTaskScopeLeases(baseTask, codingWorkflow)).toEqual([
      { mode: "write", scope: "project:p" },
    ]);
  });

  test("declared scopes replace conservative defaults", () => {
    expect(effectiveTaskScopeLeases({ ...baseTask, scopes: { read: ["package:packages/ui"], write: ["file:README.md"] } }, codingWorkflow)).toEqual([
      { mode: "read", scope: "package:packages/ui" },
      { mode: "write", scope: "file:README.md" },
    ]);
  });

  test("conflict rules are project-aware and conservative for project scopes", () => {
    expect(scopeLeasesConflict(lease({ mode: "read", scope: "file:a" }), lease({ mode: "read", scope: "file:a" }))).toBe(false);
    expect(scopeLeasesConflict(lease({ scope: "package:packages/ui" }), lease({ scope: "file:README.md" }))).toBe(false);
    expect(scopeLeasesConflict(lease({ scope: "package:packages/ui" }), lease({ scope: "package:packages/ui/src" }))).toBe(true);
    expect(scopeLeasesConflict(lease({ scope: "project:p" }), lease({ scope: "file:README.md", projectId: "p" }))).toBe(true);
    expect(scopeLeasesConflict(lease({ scope: "project:p2" }), lease({ scope: "file:README.md", projectId: "p" }))).toBe(false);
    expect(scopeLeasesConflict(lease({ scope: "release:npm", projectId: "a" }), lease({ scope: "release:npm", projectId: "b" }))).toBe(true);
  });

  test("json store acquires, rejects conflicts, releases, and reclaims expired leases", async () => {
    const dir = await tmp();
    try {
      let now = 1_000;
      const store = new JsonScopeLeaseStore(dir, () => now);
      const a = await store.acquire({
        taskId: "a",
        wakeId: "wa",
        projectId: "p",
        leases: [{ mode: "write", scope: "project:p" }],
        ttlMs: 100,
      });
      expect(a.acquired).toBe(true);

      const b = await store.acquire({
        taskId: "b",
        wakeId: "wb",
        projectId: "p",
        leases: [{ mode: "write", scope: "file:README.md" }],
        ttlMs: 100,
      });
      expect(b.acquired).toBe(false);

      await store.release("a", "wa");
      expect((await store.acquire({
        taskId: "b",
        wakeId: "wb",
        projectId: "p",
        leases: [{ mode: "write", scope: "file:README.md" }],
        ttlMs: 100,
      })).acquired).toBe(true);

      now += 101;
      expect(await store.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
