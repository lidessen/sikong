import { describe, expect, test } from "vitest";
import { createExecutor, MockAdapter } from "../index";
import type { LoopEvent } from "../index";

describe("executor + mock adapter", () => {
  test("one run streams events and resolves a result", async () => {
    const exec = createExecutor("mock", { response: "hello world" });
    const run = exec.run("hi");

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
    const exec = createExecutor("mock");
    const a = await exec.run("ping").result;
    const b = await exec.run({ prompt: "ping" }).result;
    expect(a.text).toBe(b.text);
  });

  test("onMessage / onUsage / onEnd hooks fire", async () => {
    const exec = createExecutor("mock", { response: "abc" });
    let messages = 0;
    let usageSeen = 0;
    let ended = false;

    const run = exec.run({
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

  test("onToolUse can deny a tool (hooks capability)", async () => {
    const exec = createExecutor("mock", {
      simulateTool: "rm",
      toolArgs: { path: "/" },
    });
    const seen: LoopEvent[] = [];
    const run = exec.run({
      prompt: "delete everything",
      hooks: {
        onToolUse: (ev) =>
          ev.name === "rm" ? { action: "deny", reason: "nope" } : { action: "continue" },
      },
    });
    for await (const ev of run) seen.push(ev);

    const end = seen.find(
      (e): e is Extract<LoopEvent, { type: "tool_call_end" }> =>
        e.type === "tool_call_end",
    );
    expect(end?.error).toContain("denied");
    expect(seen.some((e) => e.type === "tool_call_start")).toBe(false);
  });

  test("onToolUse can replace args", async () => {
    const exec = createExecutor("mock", {
      simulateTool: "write",
      toolArgs: { path: "/tmp/a" },
    });
    const seen: LoopEvent[] = [];
    const run = exec.run({
      prompt: "write",
      hooks: {
        onToolUse: () => ({ action: "replaceArgs", args: { path: "/tmp/safe" } }),
      },
    });
    for await (const ev of run) seen.push(ev);

    const start = seen.find(
      (e): e is Extract<LoopEvent, { type: "tool_call_start" }> =>
        e.type === "tool_call_start",
    );
    expect(start?.args).toEqual({ path: "/tmp/safe" });
  });

  test("steer is routed and reported (deferred on mock)", async () => {
    const exec = createExecutor("mock");
    const run = exec.run("work");
    const outcome = await run.steer("also run tests");
    expect(outcome.mode).toBe("deferred");
    const result = await run.result;
    expect(result.events.some((e) => e.type === "steer")).toBe(true);
  });

  test("capability gating: tools on a no-tools backend would throw", async () => {
    // Build an adapter that advertises no capabilities.
    const bare = new MockAdapter();
    (bare as { capabilities: readonly string[] }).capabilities = [];
    const exec = createExecutor(bare);
    expect(() =>
      exec.run({ prompt: "x", tools: { foo: { description: "f" } } }),
    ).toThrow(/does not support capability "tools"/);
  });
});
