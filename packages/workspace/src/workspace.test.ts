import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileWorkspacePreferencesFactory,
  FileWorkspaceStore,
  ensureHomeLayout,
  isValidWorkspaceId,
  preferencesFile,
  resolveHomeDir,
  taskEventsDir,
  taskProjectionsDir,
  workspaceDir,
  worktreeDir,
  worktreesDir,
} from "./index";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-workspace-"));

describe("workspace home layout", () => {
  test("resolves home from flag, env, then default", () => {
    expect(resolveHomeDir({ homeDir: "/tmp/home", env: {} }).source).toBe("flag");
    expect(resolveHomeDir({ env: { SIKONG_HOME: "/tmp/env-home" } }).dir).toBe("/tmp/env-home");
    expect(resolveHomeDir({ env: {} }).dir).toContain(".sikong");
  });

  test("creates the home layout and stable workspace paths", async () => {
    const dir = await tmp();
    try {
      await ensureHomeLayout(dir);

      expect(workspaceDir(dir, "main")).toBe(join(dir, "workspaces", "main"));
      expect(taskEventsDir(dir, "main")).toBe(join(dir, "workspaces", "main", "state", "events"));
      expect(taskProjectionsDir(dir, "main")).toBe(
        join(dir, "workspaces", "main", "state", "projections"),
      );
      expect(worktreesDir(dir, "main")).toBe(join(dir, "workspaces", "main", "worktrees"));
      expect(worktreeDir(dir, "main", "task/one")).toBe(
        join(dir, "workspaces", "main", "worktrees", "task_one"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("workspace store", () => {
  test("validates workspace ids", () => {
    expect(isValidWorkspaceId("sikong")).toBe(true);
    expect(isValidWorkspaceId("a.b-c_1")).toBe(true);
    expect(isValidWorkspaceId("")).toBe(false);
    expect(isValidWorkspaceId(".")).toBe(false);
    expect(isValidWorkspaceId("..")).toBe(false);
    expect(isValidWorkspaceId("a/b")).toBe(false);
  });

  test("stores, lists, reads, and deletes workspace definitions", async () => {
    const dir = await tmp();
    try {
      const store = new FileWorkspaceStore(dir);
      await store.put({ id: "sikong", name: "Sikong" });
      await store.put({ id: "docs", name: "Docs" });

      expect(await store.get("sikong")).toEqual({ id: "sikong", name: "Sikong" });
      expect((await store.list()).map((workspace) => workspace.id)).toEqual(["docs", "sikong"]);
      expect(await readFile(join(dir, "workspaces", "sikong", "workspace.yaml"), "utf8")).toContain(
        "Sikong",
      );

      await store.delete("docs");
      expect(await store.get("docs")).toBeNull();
      expect((await store.list()).map((workspace) => workspace.id)).toEqual(["sikong"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid workspace definitions", async () => {
    const dir = await tmp();
    try {
      const store = new FileWorkspaceStore(dir);
      await expect(store.put({ id: "bad/id", name: "Bad" })).rejects.toThrow(
        "invalid workspace id",
      );
      await expect(store.put({ id: "ok", name: "" })).rejects.toThrow("workspace name");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("workspace preferences", () => {
  test("reads empty preferences when preferences.yaml is absent", async () => {
    const dir = await tmp();
    try {
      const preferences = new FileWorkspacePreferencesFactory(dir).open({
        id: "sikong",
        name: "Sikong",
      });
      expect(await preferences.read()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes and appends preferences as YAML", async () => {
    const dir = await tmp();
    try {
      const preferences = new FileWorkspacePreferencesFactory(dir).open({
        id: "sikong",
        name: "Sikong",
      });

      await preferences.write([{ id: "verify", text: "Run bun run check before handoff." }]);
      const appended = await preferences.append({
        text: "Keep workspace directories separate from agent cwd.",
        note: "Workspace stores Sikong state.",
        sourceTaskId: "task_1",
      });

      expect(appended.id).toBe("keep-workspace-directories-separate");
      expect(await preferences.read()).toEqual([
        { id: "verify", text: "Run bun run check before handoff." },
        {
          id: "keep-workspace-directories-separate",
          text: "Keep workspace directories separate from agent cwd.",
          note: "Workspace stores Sikong state.",
          sourceTaskId: "task_1",
        },
      ]);
      const yaml = await readFile(preferencesFile(dir, "sikong"), "utf8");
      expect(yaml).toContain("preferences:");
      expect(yaml).toContain("keep-workspace-directories-separate");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deduplicates generated preference ids", async () => {
    const dir = await tmp();
    try {
      const preferences = new FileWorkspacePreferencesFactory(dir).open({
        id: "sikong",
        name: "Sikong",
      });
      expect((await preferences.append({ text: "Run bun run check" })).id).toBe(
        "run-bun-run-check",
      );
      expect((await preferences.append({ text: "Run bun run check" })).id).toBe(
        "run-bun-run-check-2",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
