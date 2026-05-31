import { describe, expect, test } from "vitest";
import { MemoryChronicleStore, MemoryEventStore, MemoryProjectionStore } from "../store/memory";
import { renderStatus, renderTaskDetail, taskDetail, workspaceStatus } from "./inspect";
import { initTask, project } from "../workflow/reducer";
import { GENERAL_WORKFLOW } from "../workflow/builtin";

describe("inspect", () => {
  test("workspaceStatus aggregates counts, activity, and errors", async () => {
    const events = new MemoryEventStore(() => 1);
    const projections = new MemoryProjectionStore();
    const chronicle = new MemoryChronicleStore(() => 1);

    await events.append("t1", initTask({ taskId: "t1", projectId: "p", workflow: GENERAL_WORKFLOW }));
    await projections.put(project(await events.load("t1"), GENERAL_WORKFLOW));
    await chronicle.append({ type: "task.created", taskId: "t1", summary: "created" });
    await chronicle.append({ type: "wake.error", taskId: "t1", summary: "boom" });

    const v = await workspaceStatus(projections, chronicle);
    expect(v.total).toBe(1);
    expect(v.counts.in_progress).toBe(1);
    expect(v.tasks[0]?.id).toBe("t1");
    expect(v.recentErrors.map((e) => e.summary)).toContain("boom");

    const rendered = renderStatus(v);
    expect(rendered).toContain("t1");
    expect(rendered).toContain("boom");
  });

  test("taskDetail returns projection + timeline + activity, or null", async () => {
    const events = new MemoryEventStore(() => 1);
    const projections = new MemoryProjectionStore();
    const chronicle = new MemoryChronicleStore(() => 1);

    await events.append("t1", initTask({ taskId: "t1", projectId: "p", workflow: GENERAL_WORKFLOW }));
    await projections.put(project(await events.load("t1"), GENERAL_WORKFLOW));

    const d = await taskDetail("t1", events, projections, chronicle);
    expect(d?.task?.id).toBe("t1");
    expect(d?.timeline.length).toBe(1);
    expect(d && renderTaskDetail(d)).toContain("stage: open");

    expect(await taskDetail("nope", events, projections, chronicle)).toBeNull();
  });

  test("taskDetail shows the log even when the projection isn't materialized yet", async () => {
    const events = new MemoryEventStore(() => 1);
    const projections = new MemoryProjectionStore();
    const chronicle = new MemoryChronicleStore(() => 1);
    // Append events but DON'T persist a projection — the engine's append→persist window.
    await events.append("t1", initTask({ taskId: "t1", projectId: "p", workflow: GENERAL_WORKFLOW }));

    const d = await taskDetail("t1", events, projections, chronicle);
    expect(d?.task).toBeNull();
    expect(d?.timeline.length).toBe(1);
    expect(d && renderTaskDetail(d)).toContain("not yet materialized");
  });
});
