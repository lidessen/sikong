import { describe, expect, test } from "vitest";
import {
  MemoryChronicleStore,
  MemoryEventStore,
  MemoryProjectStore,
  MemoryProjectionStore,
  MemoryWorkerStore,
} from "../store/memory";
import { renderLeadActions, renderOverview, renderStatus, renderTaskDetail, taskDetail, workspaceOverview, workspaceStatus } from "./inspect";
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

  test("taskDetail renders deterministic lead team status", async () => {
    const events = new MemoryEventStore(() => 1);
    const projections = new MemoryProjectionStore();
    const chronicle = new MemoryChronicleStore(() => 1);

    await events.append("parent", initTask({ taskId: "parent", projectId: "p", workflow: GENERAL_WORKFLOW }));
    await events.append("child", [
      ...initTask({
        taskId: "child",
        projectId: "p",
        workflow: GENERAL_WORKFLOW,
        parentId: "parent",
        fields: { request: "do child work", summary: "child finished" },
      }),
      { taskId: "child", source: "engine", type: "stage.entered", payload: { stageId: "done" } },
    ]);
    await events.append("parent", [
      {
        taskId: "parent",
        source: "engine",
        type: "subtask.created",
        payload: { childId: "child", workflowId: GENERAL_WORKFLOW.id },
      },
    ]);
    await projections.put(project(await events.load("child"), GENERAL_WORKFLOW));
    await projections.put(project(await events.load("parent"), GENERAL_WORKFLOW));

    const d = await taskDetail("parent", events, projections, chronicle);
    expect(d?.leadStatus?.classification).toBe("ready_for_parent_review");

    const rendered = d && renderTaskDetail(d);
    expect(rendered).toContain("lead/team:");
    expect(rendered).toContain("classification: ready_for_parent_review");
    expect(rendered).toContain("children: total=1 done=1 cancelled=0 active=0");
    expect(rendered).toContain("child (general@done) [done]");

    const status = await workspaceStatus(projections, chronicle, { events });
    expect(status.pendingLeadActions).toHaveLength(1);
    expect(status.pendingLeadActions[0]).toMatchObject({
      taskId: "parent",
      classification: "ready_for_parent_review",
      childCount: 1,
      activeChildren: 0,
      suggestedCommand: "sikong task parent --text",
    });
    expect(renderStatus(status)).toContain("Pending lead actions:");
    expect(renderStatus(status)).toContain("parent [ready_for_parent_review]");

    const overview = await workspaceOverview(
      {
        projects: new MemoryProjectStore([{ id: "p", name: "Project P", root: "/tmp/p" }]),
        workers: new MemoryWorkerStore(),
        projections,
        chronicle,
        events,
      },
    );
    expect(overview.pendingLeadActions.map((action) => action.taskId)).toEqual(["parent"]);
    expect(renderOverview(overview)).toContain("parent [ready_for_parent_review]");
    expect(renderLeadActions(overview.pendingLeadActions)).toContain("Pending lead actions:");
    expect(renderLeadActions(overview.pendingLeadActions)).toContain("parent [ready_for_parent_review]");
    expect(renderLeadActions(overview.pendingLeadActions)).toContain("command: sikong task parent --text");
  });

  test("workspaceStatus surfaces worker work-log review actions from chronicle", async () => {
    const events = new MemoryEventStore(() => 1);
    const projections = new MemoryProjectionStore();
    const chronicle = new MemoryChronicleStore(() => 1);
    const timeline = await events.append(
      "needs-review",
      initTask({
        taskId: "needs-review",
        projectId: "p",
        workflow: GENERAL_WORKFLOW,
        fields: { request: "inspect" },
      }),
    );
    await projections.put(project(timeline, GENERAL_WORKFLOW));
    await chronicle.append({
      type: "wake.review_required",
      taskId: "needs-review",
      wakeId: "w1",
      summary: "worker pass ended without durable state",
      data: { reason: "no_state_commands" },
    });

    const status = await workspaceStatus(projections, chronicle, { events });

    expect(status.pendingLeadActions).toHaveLength(1);
    expect(status.pendingLeadActions[0]).toMatchObject({
      taskId: "needs-review",
      classification: "worker_log_review_required",
      suggestedCommand: "sikong trace needs-review --text",
      wakeId: "w1",
    });
    expect(renderLeadActions(status.pendingLeadActions)).toContain("needs-review [worker_log_review_required]");
    expect(renderLeadActions(status.pendingLeadActions)).toContain("wake=w1");
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

  test("workspaceOverview combines projects, workers, tasks, and activity", async () => {
    const events = new MemoryEventStore(() => 1);
    const projects = new MemoryProjectStore([{ id: "p", name: "Project P", root: "/tmp/p", defaultWorker: "w" }]);
    const workers = new MemoryWorkerStore([
      {
        id: "w",
        name: "Worker W",
        runtime: "ai-sdk",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        description: "does project work",
      },
    ]);
    const projections = new MemoryProjectionStore();
    const chronicle = new MemoryChronicleStore(() => 1);

    await events.append("t1", initTask({ taskId: "t1", projectId: "p", workflow: GENERAL_WORKFLOW }));
    await projections.put(project(await events.load("t1"), GENERAL_WORKFLOW));
    await chronicle.append({ type: "task.created", taskId: "t1", summary: "created" });

    const v = await workspaceOverview(
      { projects, workers, projections, chronicle },
      { defaultWorkerId: "w" },
    );
    expect(v.projects[0]?.id).toBe("p");
    expect(v.projects[0]?.counts.in_progress).toBe(1);
    expect(v.workers[0]?.isDefault).toBe(true);
    expect(v.recentTasks[0]?.id).toBe("t1");

    const rendered = renderOverview(v, { dir: ".sikong" });
    expect(rendered).toContain("Projects:");
    expect(rendered).toContain("Project P");
    expect(rendered).toContain("Workers:");
    expect(rendered).toContain("t1");
  });
});
