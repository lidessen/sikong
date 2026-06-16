import { describe, expect, test } from "vitest";
import { codexLoop, defineTool, mockLoop } from "../index";

describe("run handle ergonomics", () => {
  test("textStream yields assistant text only", async () => {
    const run = mockLoop({ response: "hello world" }).run("hi");
    let acc = "";
    for await (const chunk of run.textStream) acc += chunk;
    expect(acc).toBe("hello world");
  });

  test("run.text and run.usage resolve without manual iteration", async () => {
    const run = mockLoop({ response: "abc" }).run("hi");
    expect(await run.text).toBe("abc");
    expect((await run.usage).totalTokens).toBeGreaterThan(0);
  });

  test("event stream is independently consumable (replay broadcast)", async () => {
    const run = mockLoop({ response: "xy" }).run("hi");
    // Consume textStream fully first…
    let streamed = "";
    for await (const c of run.textStream) streamed += c;
    // …then the full event stream still replays from the start.
    const types = new Set<string>();
    for await (const ev of run) types.add(ev.type);
    expect(streamed).toBe("xy");
    expect(types.has("text")).toBe(true);
    expect(types.has("usage")).toBe(true);
  });

  test("result never rejects on error; surfaces status + error event", async () => {
    const loop = mockLoop({ failWith: "boom" });
    const run = loop.run("hi");
    const events: string[] = [];
    for await (const ev of run) events.push(ev.type);
    const r = await run.result; // does not throw
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain("boom");
    expect(events).toContain("error");
  });
});

describe("loop.supports", () => {
  test("reflects declared capabilities", () => {
    const loop = mockLoop();
    expect(loop.supports("tools")).toBe(true);
    expect(loop.supports("hooks")).toBe(true);
    expect(loop.supports("steer.live")).toBe(false);
  });

  test("codex does not claim typed tool support without a registration protocol", () => {
    const loop = codexLoop();
    expect(loop.supports("tools")).toBe(false);
    expect(loop.supports("hooks")).toBe(false);
    expect(loop.supports("steer.live")).toBe(true);
  });
});

describe("defineTool", () => {
  test("returns a plain ToolDefinition and executes", async () => {
    const tool = defineTool({
      description: "echo",
      inputSchema: { type: "object", properties: { x: { type: "string" } } },
      execute: (args) => ({ got: args }),
    });
    expect(tool.description).toBe("echo");
    const out = await tool.execute?.({ x: "1" }, {});
    expect(out).toEqual({ got: { x: "1" } });
  });
});
