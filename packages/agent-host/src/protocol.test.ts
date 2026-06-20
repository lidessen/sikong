import { describe, expect, test } from "bun:test";
import { parseAgentRunRequest, parseRuntimeClientMessage, type AgentRunRequest } from "./protocol";

const validRequest: AgentRunRequest = {
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
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
  terminalToolSet: ["submit_work"],
};

describe("agent-host protocol schemas", () => {
  test("accept a valid run request", () => {
    expect(parseAgentRunRequest(validRequest)).toEqual(validRequest);
  });

  test("reject legacy tool choice field", () => {
    expect(() =>
      parseAgentRunRequest({
        ...validRequest,
        toolChoice: { type: "required" },
      }),
    ).toThrow();
  });

  test("reject legacy string prompts", () => {
    expect(() =>
      parseAgentRunRequest({
        ...validRequest,
        prompt: "Solve the node and call submit_work.",
      }),
    ).toThrow();
  });

  test("reject unknown request fields", () => {
    expect(() =>
      parseRuntimeClientMessage({
        type: "run",
        id: "run_1",
        request: validRequest,
        extra: true,
      }),
    ).toThrow();
  });

  test("reject unsupported protocol versions", () => {
    expect(() =>
      parseAgentRunRequest({
        ...validRequest,
        protocolVersion: 2,
      }),
    ).toThrow();
  });

  test("accept shutdown messages", () => {
    expect(parseRuntimeClientMessage({ type: "shutdown", id: "shutdown_1" })).toEqual({
      type: "shutdown",
      id: "shutdown_1",
    });
  });
});
