import { describe, expect, test } from "vitest";
import { emptyUsage, makeLoop, mockLoop, type LoopEvent } from "../index";
import { MockAdapter } from "../adapters/mock";
import type { BackendAdapter, BackendRun } from "../core/adapter";

describe("loop factories + executor", () => {
  test("one run streams events and resolves a result", async () => {
    const loop = mockLoop({ response: "hello world" });
    const run = loop.run("hi");

    const events: LoopEvent[] = [];
    for await (const ev of run) events.push(ev);

    const result = await run.result;
    expect(result.status).toBe("completed");
    expect(result.text).toBe("hello world");
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });

  test("string and object input are equivalent", async () => {
    const loop = mockLoop();
    const a = await loop.run("ping").result;
    const b = await loop.run({ prompt: "ping" }).result;
    expect(a.text).toBe(b.text);
  });

  test("capabilities are known without running the loop", () => {
    const loop = mockLoop();
    expect(loop.id).toBe("mock");
    expect(loop.capabilities).toContain("tools");
    expect(loop.capabilities).toContain("hooks");
  });

  test("onMessage / onUsage / onEnd hooks fire", async () => {
    const loop = mockLoop({ response: "abc" });
    let messages = 0;
    let usageSeen = 0;
    let ended = false;

    const run = loop.run({
      prompt: "go",
      hooks: {
        onMessage: () => {
          messages++;
        },
        onUsage: () => {
          usageSeen++;
        },
        onEnd: () => {
          ended = true;
        },
      },
    });
    await run.result;

    expect(messages).toBe(1);
    expect(usageSeen).toBe(1);
    expect(ended).toBe(true);
  });

  test("onToolUse can deny a tool", async () => {
    const loop = mockLoop({ simulateTool: "rm", toolArgs: { path: "/" } });
    const seen: LoopEvent[] = [];
    const run = loop.run({
      prompt: "delete everything",
      hooks: {
        onToolUse: (ev) =>
          ev.name === "rm" ? { action: "deny", reason: "nope" } : { action: "continue" },
      },
    });
    for await (const ev of run) seen.push(ev);

    const end = seen.find(
      (e): e is Extract<LoopEvent, { type: "tool_call_end" }> => e.type === "tool_call_end",
    );
    expect(end?.error).toContain("denied");
    expect(seen.some((e) => e.type === "tool_call_start")).toBe(false);
  });

  test("onToolUse can replace args", async () => {
    const loop = mockLoop({ simulateTool: "write", toolArgs: { path: "/tmp/a" } });
    const seen: LoopEvent[] = [];
    const run = loop.run({
      prompt: "write",
      hooks: {
        onToolUse: () => ({ action: "replaceArgs", args: { path: "/tmp/safe" } }),
      },
    });
    for await (const ev of run) seen.push(ev);

    const start = seen.find(
      (e): e is Extract<LoopEvent, { type: "tool_call_start" }> => e.type === "tool_call_start",
    );
    expect(start?.args).toEqual({ path: "/tmp/safe" });
  });

  test("steer is routed and reported (deferred on mock)", async () => {
    const loop = mockLoop();
    const run = loop.run("work");
    const outcome = await run.steer("also run tests");
    expect(outcome.mode).toBe("deferred");
    const result = await run.result;
    expect(result.events.some((e) => e.type === "steer")).toBe(true);
  });

  test("capability gating: tools on a no-tools backend throws", () => {
    const bare = makeLoop("bare", [], async () => new MockAdapter());
    expect(() => bare.run({ prompt: "x", tools: { foo: { description: "f" } } })).toThrow(
      /does not support capability "tools"/,
    );
  });

  test("cancelled backend result rejections do not surface as run errors", async () => {
    const adapter: BackendAdapter = {
      id: "cancel-reject",
      capabilities: [],
      start(): BackendRun {
        let cancelled = false;
        let rejectResult!: (err: Error) => void;
        const result = new Promise<never>((_, reject) => {
          rejectResult = reject;
        });
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "text", text: "started" } as LoopEvent;
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (cancelled) throw new Error("backend cancelled");
          },
          result,
          cancel() {
            cancelled = true;
            rejectResult(new Error("backend result cancelled"));
          },
        };
      },
    };
    const loop = makeLoop("cancel-reject", [], async () => adapter);
    const run = loop.run("go");

    run.cancel("stop");
    const result = await run.result;

    expect(result.status).toBe("cancelled");
    expect(result.error).toBeUndefined();
  });

  test("cleanup reports an already completed run as settled", async () => {
    const loop = mockLoop({ response: "done" });
    const run = loop.run("go");

    await run.result;
    const cleanup = await run.cleanup({ reason: "after result" });

    expect(cleanup).toMatchObject({
      status: "settled",
      hardKill: false,
      reason: "after result",
      runtime: "mock",
      resultStatus: "completed",
    });
  });

  test("cleanup cooperatively cancels and waits for settlement", async () => {
    let cancelled = false;
    let settleCancel!: () => void;
    const cancelSettled = new Promise<void>((resolve) => {
      settleCancel = resolve;
    });
    const adapter: BackendAdapter = {
      id: "cleanup-cancel",
      capabilities: [],
      start(): BackendRun {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "text", text: "started" } as LoopEvent;
            await cancelSettled;
          },
          result: cancelSettled.then(() => ({ usage: emptyUsage(), durationMs: 1 })),
          cancel() {
            cancelled = true;
            settleCancel();
          },
        };
      },
    };
    const loop = makeLoop("cleanup-cancel", [], async () => adapter);
    const run = loop.run("go");
    const iter = run[Symbol.asyncIterator]();
    await iter.next();

    const cleanup = await run.cleanup({ reason: "timeout", graceMs: 50 });

    expect(cancelled).toBe(true);
    expect(cleanup).toMatchObject({
      status: "cancelled_settled",
      hardKill: false,
      reason: "timeout",
      runtime: "cleanup-cancel",
      resultStatus: "cancelled",
    });
  });

  test("cleanup returns unsettled when cancellation does not settle within grace", async () => {
    let cancelled = false;
    const never = new Promise<never>(() => {});
    const adapter: BackendAdapter = {
      id: "cleanup-hang",
      capabilities: [],
      start(): BackendRun {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "text", text: "started" } as LoopEvent;
            await never;
          },
          result: never,
          cancel() {
            cancelled = true;
          },
        };
      },
    };
    const loop = makeLoop("cleanup-hang", [], async () => adapter);
    const run = loop.run("go");
    const iter = run[Symbol.asyncIterator]();
    await iter.next();

    const cleanup = await run.cleanup({ reason: "timeout", graceMs: 10 });

    expect(cancelled).toBe(true);
    expect(cleanup).toMatchObject({
      status: "unsettled",
      hardKill: false,
      reason: "timeout",
      runtime: "cleanup-hang",
      pidUnavailableReason: "adapter did not expose a process id",
    });
  });
});
