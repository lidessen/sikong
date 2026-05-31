import { afterEach, describe, expect, test } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import {
  createExitTools,
  fileStore,
  makeLoop,
  memoryStore,
  mockLoop,
  runTask,
  type Handoff,
} from "../index";
import { MockAdapter } from "../adapters/mock";

describe("createExitTools", () => {
  test("task_complete records a complete outcome", async () => {
    const { tools, outcome } = createExitTools();
    expect(outcome()).toBeNull();
    await tools.task_complete!.execute!({ summary: "done", result: { x: 1 } }, {});
    expect(outcome()).toEqual({ kind: "complete", summary: "done", result: { x: 1 } });
  });

  test("task_handoff records a handoff outcome", async () => {
    const { tools, outcome } = createExitTools();
    await tools.task_handoff!.execute!(
      { progress: "did A", nextSteps: "do B", artifacts: ["f.ts"] },
      {},
    );
    expect(outcome()).toMatchObject({
      kind: "handoff",
      progress: "did A",
      nextSteps: "do B",
      artifacts: ["f.ts"],
    });
  });
});

describe("handoff stores", () => {
  test("memoryStore round-trips", async () => {
    const s = memoryStore();
    expect(await s.load()).toEqual([]);
    const h: Handoff[] = [{ round: 1, progress: "p", nextSteps: "n", voluntary: true }];
    await s.save(h);
    expect(await s.load()).toEqual(h);
  });

  test("fileStore persists + missing file = []", async () => {
    const path = join(tmpdir(), `agent-loop-task-${process.pid}-${Math.floor(performance.now())}.json`);
    try {
      const s = fileStore(path);
      expect(await s.load()).toEqual([]);
      const h: Handoff[] = [{ round: 1, progress: "p", nextSteps: "n", voluntary: false }];
      await s.save(h);
      const onDisk = JSON.parse(await readFile(path, "utf-8"));
      expect(onDisk.handoffs).toEqual(h);
      expect(await fileStore(path).load()).toEqual(h); // fresh store, same file
    } finally {
      await rm(path, { force: true });
    }
  });
});

describe("runTask", () => {
  test("completes when the model calls task_complete", async () => {
    let rounds = 0;
    const result = await runTask({
      goal: "do the thing",
      loop: () => {
        rounds += 1;
        return rounds === 1
          ? mockLoop({ callTool: { name: "task_handoff", args: { progress: "did A", nextSteps: "do B" } } })
          : mockLoop({ callTool: { name: "task_complete", args: { summary: "all done" } } });
      },
      maxRounds: 5,
    });
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(2);
    expect(result.summary).toBe("all done");
    expect(result.handoffs).toHaveLength(1);
    expect(result.handoffs[0]).toMatchObject({ progress: "did A", voluntary: true });
  });

  test("gives up as 'stuck' after consecutive forced handoffs", async () => {
    const result = await runTask({
      goal: "x",
      loop: () => mockLoop({ response: "no exit tool called" }),
      maxRounds: 10,
      stuckRounds: 2,
    });
    expect(result.status).toBe("stuck");
    expect(result.rounds).toBe(2);
    expect(result.handoffs.every((h) => !h.voluntary)).toBe(true);
  });

  test("exhausts maxRounds with voluntary handoffs", async () => {
    const result = await runTask({
      goal: "x",
      loop: () => mockLoop({ callTool: { name: "task_handoff", args: { progress: "p", nextSteps: "n" } } }),
      maxRounds: 3,
      stuckRounds: 99,
    });
    expect(result.status).toBe("exhausted");
    expect(result.rounds).toBe(3);
    expect(result.handoffs).toHaveLength(3);
  });

  test("steers under context pressure (tiny contextWindow → high usedRatio)", async () => {
    const seen: string[] = [];
    let rounds = 0;
    await runTask({
      goal: "x",
      loop: () => {
        rounds += 1;
        return rounds === 1
          ? mockLoop({ contextWindow: 1, response: "lots of work" }) // tiny window → ratio ≫ 0.8
          : mockLoop({ callTool: { name: "task_complete", args: { summary: "done" } } });
      },
      maxRounds: 3,
      handoffThreshold: 0.8,
      hooks: { onEvent: (ev) => seen.push(ev.type) },
    });
    expect(seen).toContain("steer");
  });

  test("resumes from a pre-populated store", async () => {
    const store = memoryStore([
      { round: 1, progress: "earlier", nextSteps: "continue", voluntary: true },
    ]);
    const result = await runTask({
      goal: "x",
      loop: () => mockLoop({ callTool: { name: "task_complete", args: { summary: "fin" } } }),
      store,
      maxRounds: 5,
    });
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(2); // resumed at round 2
  });

  test("rejects a runtime without the tools capability", async () => {
    const noTools = makeLoop("bare", ["usage"], async () => new MockAdapter());
    const result = await runTask({ goal: "x", loop: () => noTools, maxRounds: 3 });
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("tools");
  });
});
