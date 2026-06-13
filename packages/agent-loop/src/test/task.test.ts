import { describe, expect, test } from "vitest";
import {
  createExitTools,
  createGateTools,
  defineTool,
  makeLoop,
  mockLoop,
  runTask,
  type LoopEvent,
  type TaskRoundMode,
} from "../index";
import { MockAdapter } from "../adapters/mock";
import type { BackendAdapter, BackendRun, ResolvedRequest } from "../core/adapter";

function toolCallingLoop(
  captured: ResolvedRequest[],
  toolNameOrCalls: string | Array<{ name: string; args?: Record<string, unknown> }>,
  args: Record<string, unknown> = {},
) {
  const calls = Array.isArray(toolNameOrCalls)
    ? toolNameOrCalls
    : [{ name: toolNameOrCalls, args }];
  const adapter: BackendAdapter = {
    id: "capture",
    capabilities: ["tools", "mcp", "hooks", "usage"],
    start(req): BackendRun {
      captured.push(req);
      const result = (async () => {
        await Promise.resolve();
        for (const call of calls) {
          await req.tools[call.name]?.execute?.(call.args ?? {}, { callId: "capture-call" });
        }
        return {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          durationMs: 0,
        };
      })();
      return {
        [Symbol.asyncIterator](): AsyncIterator<LoopEvent> {
          let done = false;
          return {
            async next() {
              if (!done) {
                done = true;
                await result;
              }
              return { done: true, value: undefined };
            },
          };
        },
        result,
        cancel() {},
      };
    },
  };

  return makeLoop("capture", ["tools", "mcp", "hooks", "usage"], async () => adapter);
}

describe("task and gate tools", () => {
  test("work mode exposes continue/complete/fail with namespaced task tool names", async () => {
    const { tools, outcome } = createExitTools({ mode: "work" });

    expect(tools.agent_loop_task_read).toBeDefined();
    expect(tools.agent_loop_task_continue).toBeDefined();
    expect(tools.agent_loop_task_complete).toBeDefined();
    expect(tools.agent_loop_task_fail).toBeDefined();
    expect(tools.agent_loop_task_budget_exceeded).toBeUndefined();

    await tools.agent_loop_task_continue!.execute!({ report: "partial" }, {});
    expect(outcome()).toEqual({ status: "continue", report: "partial" });
  });

  test("finish mode exposes budget_exceeded but not continue", async () => {
    const { tools, outcome } = createExitTools({ mode: "finish" });

    expect(tools.agent_loop_task_continue).toBeUndefined();
    expect(tools.agent_loop_task_budget_exceeded).toBeDefined();

    await tools.agent_loop_task_budget_exceeded!.execute!({ report: "budget spent" }, {});
    expect(outcome()).toEqual({ status: "budget_exceeded", report: "budget spent" });
  });

  test("complete and fail record terminal claims with required reports", async () => {
    const complete = createExitTools({ mode: "work" });
    await complete.tools.agent_loop_task_complete!.execute!(
      { report: "done", result: { x: 1 } },
      {},
    );
    expect(complete.outcome()).toEqual({ status: "completed", report: "done", result: { x: 1 } });

    const fail = createExitTools({ mode: "work" });
    await fail.tools.agent_loop_task_fail!.execute!({ report: "missing credentials" }, {});
    expect(fail.outcome()).toEqual({ status: "failed", report: "missing credentials" });
  });

  test("terminal task tools keep the first outcome", async () => {
    const exits = createExitTools({ mode: "work" });

    await exits.tools.agent_loop_task_complete!.execute!({ report: "done" }, {});
    await exits.tools.agent_loop_task_fail!.execute!({ report: "late failure" }, {});

    expect(exits.outcome()).toEqual({ status: "completed", report: "done" });
  });

  test("gate tools accept or reject a worker claim", async () => {
    const gate = createGateTools();

    expect(gate.tools.agent_loop_gate_accept).toBeDefined();
    expect(gate.tools.agent_loop_gate_reject).toBeDefined();

    await gate.tools.agent_loop_gate_reject!.execute!({ report: "not enough evidence" }, {});
    expect(gate.outcome()).toEqual({ decision: "reject", report: "not enough evidence" });
  });

  test("gate tools keep the first outcome", async () => {
    const gate = createGateTools();

    await gate.tools.agent_loop_gate_accept!.execute!({ report: "verified" }, {});
    await gate.tools.agent_loop_gate_reject!.execute!({ report: "too late" }, {});

    expect(gate.outcome()).toEqual({ decision: "accept", report: "verified" });
  });
});

describe("runTask", () => {
  test("continues through timeline reports until a gated completion is accepted", async () => {
    let workerCalls = 0;
    let gateCalls = 0;

    const result = await runTask({
      goal: "do the thing",
      loop: () => {
        workerCalls += 1;
        return workerCalls === 1
          ? mockLoop({
              callTool: { name: "agent_loop_task_continue", args: { report: "implemented A" } },
            })
          : mockLoop({
              callTool: { name: "agent_loop_task_complete", args: { report: "all done" } },
            });
      },
      gateLoop: () => {
        gateCalls += 1;
        return mockLoop({
          callTool: { name: "agent_loop_gate_accept", args: { report: "verified" } },
        });
      },
      maxRounds: 5,
    });

    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(2);
    expect(result.report).toBe("all done");
    expect(result.gateReport).toBe("verified");
    expect(result.timeline).toEqual([{ round: 1, report: "implemented A" }]);
    expect(gateCalls).toBe(1);
  });

  test("gate reject appends a timeline report and work continues", async () => {
    let workerCalls = 0;
    let gateCalls = 0;
    const prompts: string[] = [];

    const result = await runTask({
      goal: "x",
      loop: () => {
        workerCalls += 1;
        return workerCalls === 1
          ? mockLoop({
              callTool: {
                name: "agent_loop_task_complete",
                args: { report: "complete without tests" },
              },
            })
          : mockLoop({
              callTool: {
                name: "agent_loop_task_complete",
                args: { report: "complete with tests" },
              },
            });
      },
      gateLoop: () => {
        gateCalls += 1;
        return gateCalls === 1
          ? mockLoop({
              callTool: { name: "agent_loop_gate_reject", args: { report: "tests missing" } },
            })
          : mockLoop({
              callTool: { name: "agent_loop_gate_accept", args: { report: "tests present" } },
            });
      },
      maxRounds: 3,
      hooks: {
        onRoundStart: (_round, prompt, mode) => {
          if (mode === "work") prompts.push(prompt);
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(2);
    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0]?.report).toContain("Gate rejected the claim");
    expect(prompts[1]).toContain("tests missing");
  });

  test("accepted failed claim becomes a failed task result", async () => {
    const result = await runTask({
      goal: "x",
      loop: () =>
        mockLoop({
          callTool: { name: "agent_loop_task_fail", args: { report: "provider unavailable" } },
        }),
      gateLoop: () =>
        mockLoop({
          callTool: { name: "agent_loop_gate_accept", args: { report: "outage confirmed" } },
        }),
    });

    expect(result.status).toBe("failed");
    expect(result.report).toBe("provider unavailable");
    expect(result.gateReport).toBe("outage confirmed");
  });

  test("gate startup failures are returned as failed task results", async () => {
    const noToolsGate = makeLoop("no-tools-gate", [], async () => new MockAdapter());

    const result = await runTask({
      goal: "x",
      loop: () =>
        mockLoop({
          callTool: { name: "agent_loop_task_complete", args: { report: "done" } },
        }),
      gateLoop: () => noToolsGate,
    });

    expect(result.status).toBe("failed");
    expect(result.report).toContain("Gate failed before reviewing the worker claim");
    expect(result.error?.message).toContain('lacks the "tools" capability');
  });

  test("passes worker options through and keeps gate configuration narrow", async () => {
    const workerReqs: ResolvedRequest[] = [];
    const gateReqs: ResolvedRequest[] = [];
    const workerRuntimeOptions = { worker: true };
    let workerStarted = false;
    let gateStarted = false;
    const workerHooks = {
      onStart: () => {
        workerStarted = true;
      },
    };
    const workerMetadata = { phase: "worker" };

    const result = await runTask({
      goal: "x",
      loop: () =>
        toolCallingLoop(workerReqs, "agent_loop_task_complete", {
          report: "done",
          result: { ok: true },
        }),
      gateLoop: () =>
        toolCallingLoop(gateReqs, "agent_loop_gate_accept", {
          report: "verified",
        }),
      system: "worker system",
      skills: [{ name: "worker-skill", instructions: "worker skill text" }],
      mcp: { workerMcp: { type: "stdio", command: "worker" } },
      effort: "high",
      runtimeOptions: workerRuntimeOptions,
      runHooks: workerHooks,
      metadata: workerMetadata,
      hooks: {
        onRoundStart: (_round, _prompt, mode) => {
          if (mode === "gate") gateStarted = true;
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(workerReqs).toHaveLength(1);
    expect(gateReqs).toHaveLength(1);
    expect(workerReqs[0]?.system).toContain("worker system");
    expect(workerReqs[0]?.system).toContain("worker skill text");
    expect(workerReqs[0]?.mcp).toEqual({ workerMcp: { type: "stdio", command: "worker" } });
    expect(workerReqs[0]?.effort).toBe("high");
    expect(workerReqs[0]?.runtimeOptions).toBe(workerRuntimeOptions);
    expect(workerReqs[0]?.metadata).toBe(workerMetadata);
    expect(workerStarted).toBe(true);

    expect(gateReqs[0]?.system).toBe("");
    expect(gateReqs[0]?.mcp).toEqual({ workerMcp: { type: "stdio", command: "worker" } });
    expect(gateReqs[0]?.maxSteps).toBe(50);
    expect(gateReqs[0]?.effort).toBeUndefined();
    expect(gateReqs[0]?.runtimeOptions).toBeUndefined();
    expect(gateReqs[0]?.metadata).toBeUndefined();
    expect(gateStarted).toBe(true);
  });

  test("AgentLoop.runTask runs a task on the same loop instance", async () => {
    let calls = 0;
    const loop = mockLoop({
      callTool: { name: "agent_loop_task_complete", args: { report: "done" } },
    });
    const gate = mockLoop({
      callTool: { name: "agent_loop_gate_accept", args: { report: "verified" } },
    });
    const originalRun = loop.run;
    loop.run = (input) => {
      calls += 1;
      return originalRun(input);
    };

    const result = await loop.runTask({
      goal: "x",
      gateLoop: () => gate,
    });

    expect(calls).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.gateReport).toBe("verified");
  });

  test("skips custom tools called after a terminal task tool in the same round", async () => {
    const workerReqs: ResolvedRequest[] = [];
    let sideEffect = false;

    const result = await runTask({
      goal: "x",
      loop: () =>
        toolCallingLoop(workerReqs, [
          { name: "agent_loop_task_complete", args: { report: "done" } },
          { name: "side_effect" },
        ]),
      gateLoop: () =>
        mockLoop({
          callTool: { name: "agent_loop_gate_accept", args: { report: "verified" } },
        }),
      tools: {
        side_effect: defineTool({
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          execute: () => {
            sideEffect = true;
            return { ok: true };
          },
        }),
      },
    });

    expect(result.status).toBe("completed");
    expect(sideEffect).toBe(false);
  });

  test("work budget exhaustion enters finish-only mode and can report budget_exceeded", async () => {
    const modes: TaskRoundMode[] = [];
    let workerCalls = 0;

    const result = await runTask({
      goal: "x",
      loop: () => {
        workerCalls += 1;
        return workerCalls === 1
          ? mockLoop({
              callTool: { name: "agent_loop_task_continue", args: { report: "partial progress" } },
            })
          : mockLoop({
              callTool: {
                name: "agent_loop_task_budget_exceeded",
                args: { report: "budget spent; work remains" },
              },
            });
      },
      maxRounds: 1,
      hooks: {
        onRoundStart: (_round, _prompt, mode) => {
          modes.push(mode);
        },
      },
    });

    expect(result.status).toBe("budget_exceeded");
    expect(result.rounds).toBe(2);
    expect(result.report).toBe("budget spent; work remains");
    expect(result.timeline).toEqual([{ round: 1, report: "partial progress" }]);
    expect(modes).toEqual(["work", "finish"]);
  });

  test("finish complete claim is gated; reject after work budget returns budget_exceeded", async () => {
    let workerCalls = 0;

    const result = await runTask({
      goal: "x",
      loop: () => {
        workerCalls += 1;
        return workerCalls === 1
          ? mockLoop({
              callTool: { name: "agent_loop_task_continue", args: { report: "partial" } },
            })
          : mockLoop({
              callTool: {
                name: "agent_loop_task_complete",
                args: { report: "I think it is done" },
              },
            });
      },
      gateLoop: () =>
        mockLoop({
          callTool: { name: "agent_loop_gate_reject", args: { report: "not actually done" } },
        }),
      maxRounds: 1,
    });

    expect(result.status).toBe("budget_exceeded");
    expect(result.report).toContain("gate rejected");
    expect(result.report).toContain("not actually done");
  });

  test("gate loop can receive configured gate tools", async () => {
    let sawGateTool = false;

    const result = await runTask({
      goal: "x",
      loop: () =>
        mockLoop({
          callTool: { name: "agent_loop_task_complete", args: { report: "done" } },
        }),
      gateLoop: () =>
        mockLoop({
          callTool: { name: "gate_probe", args: {} },
        }),
      gateTools: {
        gate_probe: defineTool({
          description: "test gate tool",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          execute: () => {
            sawGateTool = true;
            return { ok: true };
          },
        }),
      },
      gateMaxSteps: 1,
    });

    expect(sawGateTool).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.report).toContain("Gate protocol violation");
  });

  test("work round without a task exit tool fails as protocol violation", async () => {
    const result = await runTask({
      goal: "x",
      loop: () => mockLoop({ response: "no terminal tool called" }),
      maxRounds: 3,
    });

    expect(result.status).toBe("failed");
    expect(result.rounds).toBe(1);
    expect(result.report).toContain("work round ended without calling");
  });

  test("rejects a runtime without the tools capability as a failed task result", async () => {
    const noTools = makeLoop("bare", ["usage"], async () => new MockAdapter());
    const result = await runTask({ goal: "x", loop: () => noTools, maxRounds: 3 });

    expect(result.status).toBe("failed");
    expect(result.report).toContain('lacks the "tools" capability');
  });
});
