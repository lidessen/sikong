import { describe, expect, test } from "bun:test";
import { mockLoop, type AgentLoop, type Capability } from "agent-loop";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, createWorkspace, type CommandContext } from "../commands";
import {
  buildClientAgentContext,
  CLIENT_AGENT_SYSTEM_PROMPT,
  runClientAgentTurn,
  type ClientTranscriptSource,
} from "./index";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-client-agent-"));

function ctx(dataDir: string): CommandContext {
  let id = 0;
  return {
    dataDir,
    workspaceId: "sikong",
    now: () => new Date("2026-06-14T00:00:00.000Z"),
    id: () => `id_${++id}`,
  };
}

describe("client agent context", () => {
  test("frames the client agent as an operator-facing coordinator", () => {
    expect(CLIENT_AGENT_SYSTEM_PROMPT).toContain("represent the human operator");
    expect(CLIENT_AGENT_SYSTEM_PROMPT).toContain(
      "Development work belongs inside Sikong Work Items",
    );
    expect(CLIENT_AGENT_SYSTEM_PROMPT).toContain("Task Lead");
    expect(CLIENT_AGENT_SYSTEM_PROMPT).toContain("Planner");
    expect(CLIENT_AGENT_SYSTEM_PROMPT).toContain("Workers");
    expect(CLIENT_AGENT_SYSTEM_PROMPT).toContain("Reviewers");
  });

  test("builds a bootstrap packet from source stores and recent transcript", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const task = await createTask(context, {
        request: "Implement Client Agent context.",
        cwd: dir,
      });
      if (!task.ok) throw new Error("task create failed");
      const transcript = fixedTranscript([
        {
          id: "m_previous",
          role: "assistant",
          createdAt: "2026-06-14T00:00:00.000Z",
          parts: [{ type: "text", text: "previous assistant reply" }],
        },
      ]);

      const packet = await buildClientAgentContext({
        ctx: context,
        currentMessage: {
          id: "m_current",
          text: "Show current Sikong work.",
          createdAt: "2026-06-14T00:00:01.000Z",
        },
        focus: { workspaceId: "sikong", taskId: task.data.taskId },
        transcript,
      });

      expect(packet.policy).toEqual({
        transcript: "query_with_tools",
        workspaceState: "authoritative",
        taskEvents: "inspect_on_demand",
        memory: "none",
      });
      expect(packet.currentMessage).toMatchObject({
        id: "m_current",
        text: "Show current Sikong work.",
      });
      expect(packet.focus).toMatchObject({ workspaceId: "sikong", source: "ui" });
      expect(packet.workspaceIndex).toMatchObject([
        { workspaceId: "sikong", name: "Sikong", activeTaskCount: 1 },
      ]);
      expect(packet.recentTranscript).toMatchObject([{ id: "m_previous", role: "assistant" }]);
      expect(packet.focusedWorkspace?.taskCards).toMatchObject([
        { taskId: task.data.taskId, status: "created" },
      ]);
      expect(packet.focusedTask?.compact).toMatchObject({
        taskId: task.data.taskId,
        status: "created",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs one turn with typed tools and an explicit context packet", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const result = await runClientAgentTurn({
        ctx: context,
        loop: mockLoop(),
        message: "Show current Sikong work.",
        focus: { workspaceId: "sikong" },
      });

      expect(result.context.policy.transcript).toBe("query_with_tools");
      expect(result.run.status).toBe("completed");
      expect(result.settlement).toEqual({ used: true, fallbackUsed: true });
      expect(result.outcome.kind).toBe("report");
      expect(result.outcomeText).toContain("mock response to:");
      expect(result.run.text).toContain("Current user message:");
      expect(result.run.text).toContain("Bootstrap context:");
      expect(result.run.text).toContain("Source policy:");
      expect(result.run.text).not.toContain("previous assistant reply");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses a structured outcome when the work pass calls finishClientTurn", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const result = await runClientAgentTurn({
        ctx: context,
        loop: mockLoop({
          callTool: {
            name: "finishClientTurn",
            args: {
              kind: "report",
              title: "Current work",
              summary: "No active tasks need attention.",
            },
          },
        }),
        message: "Show current Sikong work.",
        focus: { workspaceId: "sikong" },
      });

      expect(result.settlement).toEqual({ used: false, fallbackUsed: false });
      expect(result.outcome).toMatchObject({
        kind: "report",
        title: "Current work",
        summary: "No active tasks need attention.",
      });
      expect(result.outcomeText).toBe("No active tasks need attention.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs a settlement pass when the work pass does not finish the turn", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const loop = switchLoop([
        mockLoop({ response: "I inspected the workspace but did not finish." }),
        mockLoop({
          callTool: {
            name: "finishClientTurn",
            args: {
              kind: "question",
              question: "Which workspace should I use?",
              options: ["sikong", "Create a new workspace"],
            },
          },
        }),
      ]);

      const result = await runClientAgentTurn({
        ctx: context,
        loop,
        message: "Continue.",
        focus: { workspaceId: "sikong" },
      });

      expect(result.settlement).toEqual({ used: true, fallbackUsed: false });
      expect(result.outcome).toMatchObject({
        kind: "question",
        question: "Which workspace should I use?",
      });
      expect(result.settlementRun).toBeDefined();
      expect(result.settlementRun?.text).toContain("The previous client-agent pass ended without");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("includes backend errors when both passes fail without an outcome", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const loop = switchLoop([
        errorLoop("Cursor MCP tools/call failed"),
        errorLoop("Cursor settlement failed"),
      ]);

      const result = await runClientAgentTurn({
        ctx: context,
        loop,
        message: "Show current Sikong work.",
        focus: { workspaceId: "sikong" },
      });

      expect(result.settlement).toEqual({ used: true, fallbackUsed: true });
      expect(result.outcome.kind).toBe("report");
      if (result.outcome.kind !== "report") throw new Error("expected report outcome");
      expect(result.outcome.summary).toContain("Work pass error: Cursor MCP tools/call failed");
      expect(result.outcome.summary).toContain("Settlement pass error: Cursor settlement failed");
      expect(result.outcome.facts).toContainEqual({
        label: "work error",
        value: "Cursor MCP tools/call failed",
      });
      expect(result.outcome.facts).toContainEqual({
        label: "settlement error",
        value: "Cursor settlement failed",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns a fallback outcome when client-agent passes time out", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });

      const result = await runClientAgentTurn({
        ctx: context,
        loop: hangingLoop(),
        message: "Show current Sikong work.",
        focus: { workspaceId: "sikong" },
        passTimeoutMs: 5,
        settlementPassTimeoutMs: 5,
      });

      expect(result.settlement).toEqual({ used: false, fallbackUsed: true });
      expect(result.outcome.kind).toBe("report");
      if (result.outcome.kind !== "report") throw new Error("expected report outcome");
      expect(result.outcome.summary).toContain("client agent pass timed out");
      expect(result.outcome.facts).toContainEqual({
        label: "work pass",
        value: "error",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function fixedTranscript(
  messages: Awaited<ReturnType<ClientTranscriptSource["listRecent"]>>,
): ClientTranscriptSource {
  return {
    listRecent: async ({ limit = messages.length } = {}) => messages.slice(-limit),
    search: async ({ query, limit = messages.length }) =>
      messages
        .filter((message) => JSON.stringify(message).toLowerCase().includes(query.toLowerCase()))
        .slice(-limit),
    getRange: async ({ beforeMessageId, limit = messages.length } = {}) => {
      const end = beforeMessageId
        ? Math.max(
            0,
            messages.findIndex((message) => message.id === beforeMessageId),
          )
        : messages.length;
      return messages.slice(Math.max(0, end - limit), end);
    },
  };
}

function switchLoop(loops: AgentLoop[]): AgentLoop {
  let index = 0;
  return {
    id: "switch-mock",
    capabilities: ["tools", "mcp", "hooks", "usage"],
    supports: (cap: Capability) => loops[index]?.supports(cap) ?? cap === "tools",
    run: (input) => {
      const loop = loops[Math.min(index, loops.length - 1)]!;
      index += 1;
      return loop.run(input);
    },
    runTask: (input) => loops[Math.min(index, loops.length - 1)]!.runTask(input),
    preflight: async () => ({ ok: true }),
    dispose: async () => {},
  };
}

function errorLoop(message: string): AgentLoop {
  return {
    id: "error-mock",
    capabilities: ["tools", "mcp", "usage"],
    supports: (cap: Capability) => cap === "tools" || cap === "mcp" || cap === "usage",
    run: () => {
      const error = new Error(message);
      const result = Promise.resolve({
        events: [{ type: "error" as const, error }],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        durationMs: 1,
        status: "error" as const,
        error,
        text: "",
      });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "error" as const, error };
        },
        textStream: {
          async *[Symbol.asyncIterator]() {},
        },
        result,
        text: result.then((run) => run.text),
        usage: result.then((run) => run.usage),
        steer: async () => ({ mode: "rejected" as const }),
        cancel: () => {},
        cleanup: async () => ({
          status: "settled" as const,
          elapsedMs: 0,
          hardKill: false,
          resultStatus: "error" as const,
        }),
      };
    },
    runTask: async () => ({
      status: "failed",
      report: message,
      timeline: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      rounds: 0,
    }),
    preflight: async () => ({ ok: true }),
    dispose: async () => {},
  };
}

function hangingLoop(): AgentLoop {
  return {
    id: "hanging-mock",
    capabilities: ["tools", "mcp", "usage"],
    supports: (cap: Capability) => cap === "tools" || cap === "mcp" || cap === "usage",
    run: () => ({
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {});
        yield { type: "step" as const, phase: "start" as const, index: 0 };
      },
      textStream: {
        async *[Symbol.asyncIterator]() {},
      },
      result: new Promise(() => {}),
      text: new Promise(() => {}),
      usage: new Promise(() => {}),
      steer: async () => ({ mode: "rejected" as const }),
      cancel: () => {},
      cleanup: async () => ({
        status: "unsettled" as const,
        elapsedMs: 0,
        hardKill: false,
      }),
    }),
    runTask: async () => ({
      status: "failed",
      report: "hung",
      timeline: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      rounds: 0,
    }),
    preflight: async () => ({ ok: true }),
    dispose: async () => {},
  };
}
