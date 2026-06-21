import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDynamicTools, runMockAgentWorker, ToolLoopAgent } from "./mock-worker";
import type { AgentRunRequest } from "./protocol";

const baseRequest: AgentRunRequest = {
  protocolVersion: 1,
  objective: "Execute node 1",
  prompt: [
    { title: "Operation", content: "Solve the node." },
    { title: "Completion", content: "Call submit_work." },
  ],
  input: { kind: "engine_operation", operation: "Execute" },
  tools: [
    {
      name: "submit_work",
      description: "Submit work.",
      inputSchema: emptySchema(),
    },
  ],
  terminalToolSet: ["submit_work"],
  runtimeProfile: "general",
};

describe("mock engine worker", () => {
  test("calls the requested terminal tool", async () => {
    const result = await runMockAgentWorker(baseRequest);

    expect(result.terminalCall).toEqual({
      name: "submit_work",
      arguments: {
        output: "mock output",
      },
    });
    expect(result.report).toContain("terminal tool submit_work called");
  });

  test("selects the first terminal tool", async () => {
    const result = await runMockAgentWorker({
      ...baseRequest,
    });

    expect(result.terminalCall?.name).toBe("submit_work");
  });

  test("engine operation can finish directly with the terminal tool", async () => {
    const result = await runMockAgentWorker({
      ...baseRequest,
    });

    expect(result.report).toContain("tool calls submit_work");
    expect(result.terminalCall?.name).toBe("submit_work");
  });

  test("specification includes scope assessment", async () => {
    const result = await runMockAgentWorker({
      ...baseRequest,
      objective: "Specify node 1",
      input: {
        kind: "engine_operation",
        operation: "Specify",
        node: { intent: "size the work" },
        plan: "Execute",
      },
      tools: [
        {
          name: "submit_specification",
          description: "Submit specification.",
          inputSchema: emptySchema(),
        },
      ],
      terminalToolSet: ["submit_specification"],
    });

    expect(result.terminalCall).toEqual({
      name: "submit_specification",
      arguments: {
        next: "size the work",
        size: "small",
        reason:
          "This is closest to Small because the mock agent mirrors one local node and one terminal path.",
      },
    });
  });

  test("work runs write changed paths into a provided workspace surface", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "siko-agent-host-worktree-"));
    try {
      const result = await runMockAgentWorker({
        ...baseRequest,
        input: {
          kind: "engine_operation",
          operation: "Execute",
          node: {
            intent: "write files",
            workspace: {
              write_scope: ["src/generated.txt"],
            },
          },
          workspace_surface: {
            git_worktree_path: worktree,
            conflicts: [],
          },
        },
      });

      expect(result.terminalCall?.arguments).toMatchObject({
        output: "write files",
      });
      await expect(readFile(join(worktree, "src/generated.txt"), "utf8")).resolves.toBe(
        "mock write for src/generated.txt\n",
      );
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("loop stop condition is driven by the terminal tool set", async () => {
    const tools = createDynamicTools([
      {
        name: "inspect_context",
        description: "Inspect context.",
        inputSchema: emptySchema(),
      },
      ...baseRequest.tools,
    ]);
    const agent = new ToolLoopAgent({
      tools,
      terminalToolSet: baseRequest.terminalToolSet,
    });

    const result = await agent.run([
      { name: "inspect_context", arguments: {} },
      { name: "submit_work", arguments: {} },
    ]);

    expect(result.calls.map((call) => call.name)).toEqual(["inspect_context", "submit_work"]);
    expect(result.terminalCall?.name).toBe("submit_work");
  });

  test("assistant tool sequence is produced by the agent loop mock", async () => {
    const result = await runMockAgentWorker({
      ...baseRequest,
      objective: "Assistant turn",
      input: {
        kind: "assistant_turn",
        current_message: "analyze this repo",
        task_board: {
          active_task: null,
          tasks: [],
        },
      },
      tools: [
        {
          name: "query_messages",
          description: "Query conversation messages.",
          inputSchema: emptySchema(),
        },
        {
          name: "create_task",
          description: "Create task.",
          inputSchema: emptySchema(),
        },
        {
          name: "finish_turn",
          description: "Finish assistant turn.",
          inputSchema: emptySchema(),
        },
      ],
      terminalToolSet: ["finish_turn"],
    });

    expect(result.terminalCall).toEqual({
      name: "finish_turn",
      arguments: {
        response: "Creating task.",
        task_ids: [],
      },
    });
    expect(result.toolCalls?.map((call) => call.name)).toEqual(["create_task", "finish_turn"]);
    expect(result.toolCalls?.[0]?.arguments).toEqual({ request: "analyze this repo" });
    expect(result.report).toContain("tool calls create_task -> finish_turn");
  });
});

function emptySchema() {
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  } as const;
}
