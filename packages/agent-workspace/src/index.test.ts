import { describe, expect, test } from "vitest";
import { mockLoop } from "agent-loop";
import { AGENT_WORKSPACE_VERSION, runTask } from "./index";

// Proves the monorepo wiring: agent-workspace resolves and drives agent-loop
// across the package boundary (workspace:* symlink).
describe("agent-workspace ⇄ agent-loop wiring", () => {
  test("re-exports a working runTask from agent-loop", async () => {
    const result = await runTask({
      goal: "smoke",
      loop: () =>
        mockLoop({
          callTool: { name: "task_complete", args: { summary: "done" } },
        }),
      maxRounds: 2,
    });
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("done");
  });

  test("exposes a version marker", () => {
    expect(AGENT_WORKSPACE_VERSION).toBe("0.0.0");
  });
});
