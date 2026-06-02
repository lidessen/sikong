import { describe, expect, test } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlChronicleStore, JsonlEventStore, JsonProjectionStore } from "./jsonl";
import { initTask, project } from "../workflow/reducer";
import { GENERAL_WORKFLOW } from "../workflow/builtin";
import type { NewEvent, TaskEvent } from "../workflow/types";

const tmp = () => mkdtemp(join(tmpdir(), "aw-"));
const stamp1 = (e: NewEvent[]): TaskEvent[] => e.map((x, i) => ({ ...x, seq: i + 1, ts: 1 }));

describe("JSONL durable stores", () => {
  test("event store roundtrips + assigns monotonic seq across appends and instances", async () => {
    const dir = await tmp();
    try {
      const es = new JsonlEventStore(dir, () => 1);
      await es.append("t", initTask({ taskId: "t", projectId: "p", workflow: GENERAL_WORKFLOW }));
      await es.append("t", [
        { taskId: "t", source: "worker", type: "field.set", payload: { field: "summary", value: "x" } },
      ]);
      const log = await es.load("t");
      expect(log.map((e) => e.seq)).toEqual([1, 2]);
      expect(project(log, GENERAL_WORKFLOW).fields).toMatchObject({ summary: "x" });
      // a fresh instance reads the same persisted log
      expect((await new JsonlEventStore(dir).load("t")).length).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("projection store persists, queries by status, and 404s cleanly", async () => {
    const dir = await tmp();
    try {
      const ps = new JsonProjectionStore(dir);
      const task = project(stamp1(initTask({ taskId: "t1", projectId: "p", workflow: GENERAL_WORKFLOW })), GENERAL_WORKFLOW);
      await ps.put(task);
      expect((await ps.get("t1"))?.id).toBe("t1");
      expect((await ps.query({ status: "in_progress" })).map((x) => x.id)).toEqual(["t1"]);
      expect((await ps.query({ status: "done" })).length).toBe(0);
      expect(await ps.get("nope")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("event load tolerates a torn final line (crash mid-append)", async () => {
    const dir = await tmp();
    try {
      const es = new JsonlEventStore(dir, () => 1);
      await es.append("t", initTask({ taskId: "t", projectId: "p", workflow: GENERAL_WORKFLOW }));
      await appendFile(join(dir, "events", "t.jsonl"), '{"seq":2,"taskId":"t","ty'); // torn tail
      expect((await es.load("t")).map((e) => e.seq)).toEqual([1]); // dropped, not thrown
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("projection query skips an unparseable file instead of failing the listing", async () => {
    const dir = await tmp();
    try {
      const ps = new JsonProjectionStore(dir);
      const task = project(stamp1(initTask({ taskId: "t1", projectId: "p", workflow: GENERAL_WORKFLOW })), GENERAL_WORKFLOW);
      await ps.put(task);
      await writeFile(join(dir, "projections", "garbage.json"), "{not valid json");
      expect((await ps.query()).map((x) => x.id)).toEqual(["t1"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("chronicle store appends + recent (newest-first, filtered)", async () => {
    const dir = await tmp();
    try {
      const c = new JsonlChronicleStore(dir, () => 1);
      await c.append({ type: "task.created", taskId: "t", summary: "a" });
      await c.append({ type: "wake.end", taskId: "t", summary: "b" });
      await c.append({ type: "wake.error", taskId: "t", summary: "boom" });
      expect((await c.recent({ limit: 2 })).map((e) => e.summary)).toEqual(["boom", "b"]);
      expect((await c.recent({ type: "wake.error" })).map((e) => e.summary)).toEqual(["boom"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
