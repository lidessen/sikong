import { describe, expect, test } from "bun:test";
import { createDynamicTools, runMockAgentWorker, ToolLoopAgent } from "./mock-worker";
import type { AgentRunRequest } from "./protocol";

const baseRequest: AgentRunRequest = {
  protocolVersion: 1,
  kind: "engine_operation",
  objective: "Execute node 1",
  prompt: [
    { title: "Operation", content: "Solve the node." },
    { title: "Completion", content: "Call submit_work." },
  ],
  input: { kind: "engine_operation", operation: "Execute" },
  toolChoice: { type: "tool", name: "submit_work" },
  tools: [
    {
      name: "read_operation_context",
      description: "Read operation context.",
      inputSchema: emptySchema(),
    },
    {
      name: "submit_work",
      description: "Submit work.",
      inputSchema: emptySchema(),
    },
  ],
  terminalToolSet: ["submit_work"],
};

describe("mock engine worker", () => {
  test("calls the requested terminal tool", async () => {
    const result = await runMockAgentWorker(baseRequest);

    expect(result.terminalCall).toEqual({
      name: "submit_work",
      arguments: {
        output: "mock output",
        changed_paths: [],
        side_effects: [],
      },
    });
    expect(result.report).toContain("terminal tool submit_work called");
  });

  test("required tool choice selects the first terminal tool", async () => {
    const result = await runMockAgentWorker({
      ...baseRequest,
      toolChoice: { type: "required" },
    });

    expect(result.terminalCall?.name).toBe("submit_work");
  });

  test("non-terminal tool calls do not end the worker run", async () => {
    const result = await runMockAgentWorker({
      ...baseRequest,
      toolChoice: { type: "tool", name: "read_operation_context" },
    });

    expect(result.terminalCall).toBeUndefined();
  });

  test("loop stop condition is driven by the terminal tool set", async () => {
    const { tools } = createDynamicTools(baseRequest.tools);
    const agent = new ToolLoopAgent({
      tools,
      terminalToolSet: baseRequest.terminalToolSet,
    });

    const result = await agent.run([
      { name: "read_operation_context", arguments: {} },
      { name: "submit_work", arguments: {} },
    ]);

    expect(result.calls.map((call) => call.name)).toEqual([
      "read_operation_context",
      "submit_work",
    ]);
    expect(result.terminalCall?.name).toBe("submit_work");
  });

  test("assistant decision payload is produced by the agent loop mock", async () => {
    const result = await runMockAgentWorker({
      ...baseRequest,
      kind: "assistant_turn",
      objective: "Assistant turn",
      input: {
        kind: "assistant_turn",
        current_message: "analyze this repo",
        active_task: null,
        tasks: [],
      },
      toolChoice: { type: "required" },
      tools: [
        {
          name: "read_assistant_context",
          description: "Read assistant context.",
          inputSchema: emptySchema(),
        },
        {
          name: "submit_assistant_decision",
          description: "Submit assistant decision.",
          inputSchema: emptySchema(),
        },
      ],
      terminalToolSet: ["submit_assistant_decision"],
    });

    expect(result.terminalCall).toEqual({
      name: "submit_assistant_decision",
      arguments: {
        decision: "create_task",
        request: "analyze this repo",
        response: "Creating task.",
      },
    });
  });
});

function emptySchema() {
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  } as const;
}
