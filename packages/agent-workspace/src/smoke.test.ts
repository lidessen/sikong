import { describe, expect, test } from "vitest";
import { mockLoop, defineTool, type ToolSet } from "agent-loop";
import {
  GENERAL_WORKFLOW,
  initTask,
  project,
  reduceCommands,
  tryAdvance,
  MemoryEventStore,
  MemoryProjectionStore,
  MemoryWorkflowRegistry,
  type Command,
  type Task,
} from "./index";

/** The command tools a worker agent calls during a wake; each records a Command. */
function wakeTools(sink: Command[]): ToolSet {
  return {
    set_field: defineTool({
      description: "Set a field on the task.",
      inputSchema: {
        type: "object",
        properties: { field: { type: "string" }, value: {} },
        required: ["field", "value"],
        additionalProperties: false,
      },
      execute: (args) => {
        sink.push({ kind: "set_field", field: String(args.field), value: args.value });
        return { ok: true };
      },
    }),
    request_transition: defineTool({
      description: "Signal this stage is complete.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        additionalProperties: false,
      },
      execute: (args) => {
        sink.push({
          kind: "request_transition",
          ...(args.reason ? { reason: String(args.reason) } : {}),
        });
        return { ok: true };
      },
    }),
  };
}

// End-to-end through the WHOLE M0 spine, with a real (mock) agent run driving a
// wake: registry → create → project → wake(mockLoop) → command → reducer →
// event → guard-driven advance → projection. No creds, no LLM.
describe("M0 spine via a mockLoop wake", () => {
  test("a wake drives a GENERAL task open→done", async () => {
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    const events = new MemoryEventStore(() => 1000);
    const projections = new MemoryProjectionStore();

    const wf = registry.match("just handle this for me"); // → GENERAL default route
    expect(wf.id).toBe("general");

    await events.append("t1", initTask({ taskId: "t1", projectId: "p1", workflow: wf, source: "lead" }));
    let task: Task = project(await events.load("t1"), wf);
    await projections.put(task);
    expect(task.stageId).toBe("open");
    expect(task.status).toBe("in_progress");

    // --- WAKE: a worker agent runs with the stage's command tools injected ---
    const commands: Command[] = [];
    const wake = mockLoop({ callTool: { name: "request_transition", args: { reason: "finished" } } }).run({
      prompt: `Task t1 @ stage "${task.stageId}". Fields: ${JSON.stringify(task.fields)}.`,
      tools: wakeTools(commands),
    });
    const result = await wake.result;
    expect(result.status).toBe("completed");
    expect(commands).toEqual([{ kind: "request_transition", reason: "finished" }]);

    // --- ENGINE: fold the wake's commands → events → guard-driven advance ---
    await events.append("t1", reduceCommands(task, wf, commands, { source: "worker", wakeId: "w1" }));
    task = project(await events.load("t1"), wf);
    await events.append("t1", tryAdvance(task, wf, await events.load("t1")));
    task = project(await events.load("t1"), wf);
    await projections.put(task);

    expect(task.stageId).toBe("done");
    expect(task.status).toBe("done");

    // Determinism: re-projecting the whole log reproduces the same task.
    expect(project(await events.load("t1"), wf)).toEqual(task);

    // Queryable read side reflects it.
    expect(await projections.get("t1")).toEqual(task);
    expect((await projections.query({ status: "done" })).map((t) => t.id)).toEqual(["t1"]);
  });
});
