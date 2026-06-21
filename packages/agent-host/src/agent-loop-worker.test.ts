import { describe, expect, test } from "bun:test";
import { runtimeOptionsForWorker } from "./agent-loop-worker";
import type { AgentRunRequest } from "./protocol";

const baseRequest: AgentRunRequest = {
  protocolVersion: 1,
  objective: "Execute node 1",
  prompt: [
    { title: "Operation", content: "Solve the node." },
    { title: "Completion", content: "Call submit_work." },
  ],
  input: {
    kind: "engine_operation",
    operation: "Execute",
    node: {
      allow_write: false,
    },
    workspace_surface: {
      git_worktree_path: "/tmp/siko-worktree",
      conflicts: [],
    },
  },
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
  runtimeProfile: "code",
};

describe("agent-loop worker runtime options", () => {
  test("routes code runs into the git worktree and blocks write tools for read-only nodes", () => {
    expect(runtimeOptionsForWorker(baseRequest, "claude-code")).toMatchObject({
      cwd: "/tmp/siko-worktree",
      allowedPaths: ["/tmp/siko-worktree"],
      systemPromptPreset: "claude_code",
      builtinTools: { type: "preset", preset: "claude_code" },
      disallowedTools: expect.arrayContaining([
        "Agent",
        "Task",
        "Bash",
        "Write",
        "Edit",
        "MultiEdit",
      ]),
    });
  });

  test("routes code runs into the file-system workspace root", () => {
    const options = runtimeOptionsForWorker(
      {
        ...baseRequest,
        input: {
          kind: "engine_operation",
          operation: "Execute",
          node: {
            allow_write: false,
          },
          workspace_surface: {
            file_system_root_path: "/tmp/siko-files",
            conflicts: [],
          },
        },
      },
      "claude-code",
    );

    expect(options).toMatchObject({
      cwd: "/tmp/siko-files",
      allowedPaths: ["/tmp/siko-files"],
      disallowedTools: expect.arrayContaining(["Bash", "Write", "Edit", "MultiEdit"]),
    });
  });

  test("keeps write tools available when the engine grants write capability", () => {
    const options = runtimeOptionsForWorker(
      {
        ...baseRequest,
        input: {
          kind: "engine_operation",
          operation: "Execute",
          node: {
            allow_write: true,
          },
          workspace_surface: {
            git_worktree_path: "/tmp/siko-worktree",
            conflicts: [],
          },
        },
      },
      "claude-code",
    );

    expect(options?.disallowedTools).toEqual(["Agent", "Task", "EnterPlanMode", "ExitPlanMode"]);
  });

  test("does not create claude runtime options for ai-sdk runs", () => {
    expect(runtimeOptionsForWorker(baseRequest, "ai-sdk")).toBeUndefined();
  });
});
