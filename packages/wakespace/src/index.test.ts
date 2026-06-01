import { describe, expect, test } from "vitest";
import { mockLoop, runTask } from "agent-loop";
import { WAKESPACE_VERSION, DEVELOPMENT_WORKFLOW, GENERAL_WORKFLOW, validateWorkflow } from "./index";

// Proves the monorepo wiring: wakespace resolves and drives agent-loop
// across the package boundary (workspace:* symlink), and exposes its own kernel.
describe("wakespace ⇄ agent-loop wiring", () => {
  test("can drive agent-loop's runTask across the package boundary", async () => {
    const result = await runTask({
      goal: "smoke",
      loop: () => mockLoop({ callTool: { name: "task_complete", args: { summary: "done" } } }),
      maxRounds: 2,
    });
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("done");
  });

  test("exports the workflow kernel + a version marker", () => {
    expect(WAKESPACE_VERSION).toBe("0.1.5");
    expect(validateWorkflow(GENERAL_WORKFLOW)).toEqual([]);
    expect(validateWorkflow(DEVELOPMENT_WORKFLOW)).toEqual([]);
  });
});
