import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { WorkflowEngine, type LoopFactory } from "./engine";
import { leadAccept, newEngine, scriptLoop, SIMPLE_COMMIT } from "./test-helpers";
import { DEVELOPMENT_LEAD_WORKFLOW, DEVELOPMENT_WORKFLOW, GENERAL_WORKFLOW } from "../workflow/builtin";
import type { WorkflowDef } from "../workflow/types";
import {
  MemoryEventStore,
  MemoryProjectStore,
  MemoryProjectionStore,
  MemoryWorkflowRegistry,
} from "../store/memory";

describe("DEVELOPMENT workflow (team delegation)", () => {
  // Creates a temp project dir with passing typecheck+test scripts so the
  // acceptance gate (projectGate) on the verify/review stage succeeds.
  async function withProjectRoot(fn: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "sikong-dev-eng-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "dev-test", scripts: { typecheck: "true", test: "true" } }),
    );
    try {
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("a parent plans, delegates to a child, then reviews the team's result", async () => {
    await withProjectRoot(async (root) => {
      let parentReviewSystem = "";
      const loop: LoopFactory = (ctx) =>
        scriptLoop(async (input) => {
          if (ctx.workflow.id === "simple-commit") {
          // a team member: do the work and report a structured summary
          await input.tools?.set_field?.execute?.({ field: "summary", value: "child handled part 1" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "done part 1" }, {});
          return;
        }
        // the parent (adaptive DEVELOPMENT)
        if (ctx.stageId === "design") {
          await input.tools?.set_field?.execute?.({ field: "design", value: "decisions" }, {});
          await input.tools?.set_field?.execute?.({ field: "alternatives", value: [{ option: "B", pros: "simpler", why_rejected: "weaker fit" }] }, {});
          await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
          return;
        }
        if (ctx.stageId === "plan") {
          await input.tools?.set_field?.execute?.({ field: "plan", value: "One piece: part 1." }, {});
          await input.tools?.request_transition?.execute?.({ reason: "planned" }, {});
          return;
        }
        if (ctx.stageId === "build") {
          await input.tools?.create_subtask?.execute?.({ workflowId: "simple-commit", input: "do part 1" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
          return;
        }
        // verify — the parent must see its team here
        // Team snapshot now lives in the per-wake message (prompt), not the
        // stable system prompt (prefix-cache split) — check both.
        parentReviewSystem = `${input.system ?? ""}\n${input.prompt ?? ""}`;
        await input.tools?.set_field?.execute?.({ field: "verification", value: "Reviewed team results." }, {});
        await input.tools?.set_field?.execute?.({ field: "summary", value: "Team completed the effort." }, {});
        await input.tools?.request_transition?.execute?.({ reason: "verified" }, {});
      });
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    registry.register(DEVELOPMENT_WORKFLOW);
    registry.register(SIMPLE_COMMIT);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
      registry,
      loop,
    });

    await engine.createTask({
      projectId: "p",
      workflowId: "development",
      taskId: "parent1",
      fields: { request: "ship the effort" },
    });
    await engine.idle();
    await leadAccept(engine, "parent1");

    const task = await engine.getTask("parent1");
    expect(task?.status).toBe("done");
    expect(task?.fields.summary).toBe("Team completed the effort.");
    expect(task?.childIds.length).toBe(1);
    const childId = task!.childIds[0]!;
    expect((await engine.getTask(childId))?.status).toBe("done");
    // the parent saw its team — id, status, and the child's structured summary — in verify
    expect(parentReviewSystem).toContain("## Lead team status");
    expect(parentReviewSystem).toContain("classification: ready_for_parent_review");
    expect(parentReviewSystem).toContain("children: total=1 done=1 cancelled=0 active=0");
    expect(parentReviewSystem).toContain("## Team (your subtasks)");
    expect(parentReviewSystem).toContain(childId);
    expect(parentReviewSystem).toContain(`simple-commit@done`);
    expect(parentReviewSystem).toContain("child handled part 1");
    });
  });

  test("a parent can run another round in verify before finishing (multi-round)", async () => {
    await withProjectRoot(async (root) => {
      let verifyPasses = 0;
      const loop: LoopFactory = (ctx) =>
        scriptLoop(async (input) => {
          if (ctx.workflow.id === "simple-commit") {
            await input.tools?.set_field?.execute?.({ field: "summary", value: "child finished" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "child done" }, {});
            return;
          }
          if (ctx.stageId === "design") {
            await input.tools?.set_field?.execute?.({ field: "design", value: "decisions" }, {});
            await input.tools?.set_field?.execute?.({ field: "alternatives", value: [{ option: "B", pros: "simpler", why_rejected: "weaker fit" }] }, {});
            await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
            return;
          }
          if (ctx.stageId === "plan") {
            await input.tools?.set_field?.execute?.({ field: "plan", value: "Part A first, then maybe a follow-up." }, {});
            await input.tools?.request_transition?.execute?.({ reason: "planned" }, {});
            return;
          }
          if (ctx.stageId === "build") {
            await input.tools?.create_subtask?.execute?.({ workflowId: "simple-commit", input: "part A" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
            return;
          }
          // verify
          verifyPasses++;
          if (verifyPasses === 1) {
            // need another round: spawn a follow-up, do NOT set summary yet
            await input.tools?.create_subtask?.execute?.({ workflowId: "simple-commit", input: "part B" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "another round" }, {});
            return;
          }
          await input.tools?.set_field?.execute?.({ field: "verification", value: "Verified all rounds." }, {});
          await input.tools?.set_field?.execute?.({ field: "summary", value: "All rounds complete." }, {});
          await input.tools?.request_transition?.execute?.({ reason: "complete" }, {});
        });
      const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
      registry.register(DEVELOPMENT_WORKFLOW);
      registry.register(SIMPLE_COMMIT);
      const engine = new WorkflowEngine({
        events: new MemoryEventStore(() => 1),
        projections: new MemoryProjectionStore(),
        projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
        registry,
        loop,
      });

      await engine.createTask({
        projectId: "p",
        workflowId: "development",
        taskId: "parent-multi",
        fields: { request: "two-round effort" },
      });
      await engine.idle();
      await leadAccept(engine, "parent-multi");

      const task = await engine.getTask("parent-multi");
      expect(verifyPasses).toBe(2); // re-woken for a second verify round after the follow-up finished
      expect(task?.status).toBe("done");
      expect(task?.fields.summary).toBe("All rounds complete.");
      expect(task?.childIds.length).toBe(2); // initial team member + the follow-up
      for (const cid of task!.childIds) expect((await engine.getTask(cid))?.status).toBe("done");
    });
  });

  test("an isolated subtask marks the child and runs the worker-boundary hooks (ADR 0010)", async () => {
    await withProjectRoot(async (root) => {
      const isolated: string[] = [];
      const released: string[] = [];
      const loop: LoopFactory = (ctx) =>
        scriptLoop(async (input) => {
          if (ctx.workflow.id === "simple-commit") {
            await input.tools?.set_field?.execute?.({ field: "summary", value: "isolated child done" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
            return;
          }
          if (ctx.stageId === "design") {
            await input.tools?.set_field?.execute?.({ field: "design", value: "decisions" }, {});
            await input.tools?.set_field?.execute?.({ field: "alternatives", value: [{ option: "B", pros: "simpler", why_rejected: "weaker fit" }] }, {});
            await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
            return;
          }
          if (ctx.stageId === "plan") {
            await input.tools?.set_field?.execute?.({ field: "plan", value: "one isolated piece" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "planned" }, {});
            return;
          }
          if (ctx.stageId === "build") {
            await input.tools?.create_subtask?.execute?.({ workflowId: "simple-commit", input: "part X", isolate: true }, {});
            await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
            return;
          }
          await input.tools?.set_field?.execute?.({ field: "summary", value: "done" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "reviewed" }, {});
        });
      const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
      registry.register(DEVELOPMENT_WORKFLOW);
      registry.register(SIMPLE_COMMIT);
      const engine = new WorkflowEngine({
        events: new MemoryEventStore(() => 1),
        projections: new MemoryProjectionStore(),
        projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
        registry,
        loop,
        isolateWorkspace: (ctx, project) => {
          isolated.push(ctx.task.id);
          return project;
        },
        releaseWorkspace: (task) => {
          released.push(task.id);
        },
      });

      await engine.createTask({ projectId: "p", workflowId: "development", taskId: "iso-parent", fields: { request: "x" } });
      await engine.idle();
      await leadAccept(engine, "iso-parent");

      const parent = await engine.getTask("iso-parent");
      expect(parent?.status).toBe("done");
      expect(parent?.childIds.length).toBe(1);
      const childId = parent!.childIds[0]!;
      const child = await engine.getTask(childId);
      expect(child?.isolate).toBe(true); // the child carries the isolation flag
      expect(child?.status).toBe("done");
      // the worker boundary saw the isolated child on its wake, and released it on terminal
      expect(isolated).toContain(childId);
      expect(released).toContain(childId);
      // the parent itself was never isolated
      expect(isolated).not.toContain("iso-parent");
    });
  });

  test("a child whose wakes keep failing is auto-failed so the parent unblocks (ADR 0010 #2)", async () => {
    await withProjectRoot(async (root) => {
      let childWakes = 0;
      const loop: LoopFactory = (ctx) => {
        if (ctx.workflow.id === "simple-commit") {
          // a stuck/failing child: its wake errors every time (e.g. a build that times out)
          return scriptLoop(async () => {
            childWakes++;
            throw new Error("simulated build failure");
          }, "ai-sdk");
        }
        return scriptLoop(async (input) => {
          if (ctx.stageId === "design") {
            await input.tools?.set_field?.execute?.({ field: "design", value: "decisions" }, {});
            await input.tools?.set_field?.execute?.({ field: "alternatives", value: [{ option: "B", pros: "simpler", why_rejected: "weaker fit" }] }, {});
            await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
            return;
          }
          if (ctx.stageId === "plan") {
            await input.tools?.set_field?.execute?.({ field: "plan", value: "one piece" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "planned" }, {});
            return;
          }
          if (ctx.stageId === "build") {
            await input.tools?.create_subtask?.execute?.({ workflowId: "simple-commit", input: "do x" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
            return;
          }
          // verify
          await input.tools?.set_field?.execute?.({ field: "verification", value: "Child failed; effort closed." }, {});
          await input.tools?.set_field?.execute?.({ field: "summary", value: "child failed; effort closed" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
        });
      };
      const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
      registry.register(DEVELOPMENT_WORKFLOW);
      registry.register(SIMPLE_COMMIT);
      const engine = new WorkflowEngine({
        events: new MemoryEventStore(() => 1),
        projections: new MemoryProjectionStore(),
        projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
        registry,
        loop,
        maxWakeRetries: 1, // one retry, then terminal-fail
      });

      await engine.createTask({ projectId: "p", workflowId: "development", taskId: "fail-parent", fields: { request: "x" } });
      await engine.idle();
      await leadAccept(engine, "fail-parent");

      const parent = await engine.getTask("fail-parent");
      expect(childWakes).toBeGreaterThanOrEqual(2); // initial + one retry before auto-fail
      const childId = parent!.childIds[0]!;
      expect((await engine.getTask(childId))?.status).toBe("cancelled"); // auto-failed → terminal
      expect(parent?.status).toBe("done"); // childrenDone resolved — the parent was NOT wedged
    });
  });

  test("the parent can order subtasks with dependsOn — a dependent runs only after its prerequisite (ADR 0011)", async () => {
    await withProjectRoot(async (root) => {
      const order: string[] = [];
      const loop: LoopFactory = (ctx) =>
      scriptLoop(async (input) => {
        if (ctx.workflow.id === "general") {
          order.push(String(ctx.task.fields.request)); // record run order
          await input.tools?.set_field?.execute?.({ field: "summary", value: `did ${ctx.task.fields.request}` }, {});
          await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
          return;
        }
        if (ctx.stageId === "design") {
          await input.tools?.set_field?.execute?.({ field: "design", value: "decisions" }, {});
          await input.tools?.set_field?.execute?.({ field: "alternatives", value: [{ option: "B", pros: "simpler", why_rejected: "weaker fit" }] }, {});
          await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
          return;
        }
        if (ctx.stageId === "plan") {
          await input.tools?.set_field?.execute?.({ field: "plan", value: "A then B" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "planned" }, {});
          return;
        }
        if (ctx.stageId === "build") {
          await input.tools?.create_subtask?.execute?.({ workflowId: "general", input: "A", key: "a" }, {});
          await input.tools?.create_subtask?.execute?.({ workflowId: "general", input: "B", key: "b", dependsOn: ["a"] }, {});
          await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
          return;
        }
        // verify
        await input.tools?.set_field?.execute?.({ field: "verification", value: "both layers done" }, {});
        await input.tools?.set_field?.execute?.({ field: "summary", value: "both layers done" }, {});
        await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
      });
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    registry.register(DEVELOPMENT_WORKFLOW);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
      registry,
      loop,
    });

    await engine.createTask({ projectId: "p", workflowId: "development", taskId: "dag-parent", fields: { request: "x" } });
    await engine.idle();
    await leadAccept(engine, "dag-parent");

    const parent = await engine.getTask("dag-parent");
    expect(order).toEqual(["A", "B"]); // B waited for A (dependency respected), not parallel
    expect(parent?.status).toBe("done");
    expect(parent?.childIds.length).toBe(2);
    for (const c of parent!.childIds) expect((await engine.getTask(c))?.status).toBe("done");
    // the dependent carries the resolved prerequisite id
    const tasks = await Promise.all(parent!.childIds.map((c) => engine.getTask(c)));
    const b = tasks.find((t) => t?.fields.request === "B");
    const a = tasks.find((t) => t?.fields.request === "A");
    expect(b?.dependsOn).toEqual([a?.id]);
    });
  });

  test("DEVELOPMENT_LEAD_WORKFLOW alias still delegates and completes end-to-end", async () => {
    await withProjectRoot(async (root) => {
      const loop: LoopFactory = (ctx) =>
        scriptLoop(async (input) => {
          if (ctx.workflow.id === SIMPLE_COMMIT.id) {
            await input.tools?.set_field?.execute?.({ field: "summary", value: "alias child done" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
            return;
          }
          if (ctx.stageId === "design") {
            await input.tools?.set_field?.execute?.({ field: "design", value: "alias test" }, {});
            await input.tools?.set_field?.execute?.({ field: "alternatives", value: [{ option: "A", pros: "fast", why_rejected: "weaker fit" }] }, {});
            await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
          return;
        }
        if (ctx.stageId === "plan") {
          await input.tools?.set_field?.execute?.({ field: "plan", value: "delegate" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "planned" }, {});
          return;
        }
        if (ctx.stageId === "build") {
          await input.tools?.create_subtask?.execute?.({ workflowId: "simple-commit", input: "alias sub" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
          return;
        }
        // verify
        await input.tools?.set_field?.execute?.({ field: "verification", value: "alias verified" }, {});
        await input.tools?.set_field?.execute?.({ field: "summary", value: "alias done" }, {});
        await input.tools?.request_transition?.execute?.({ reason: "verified" }, {});
      });
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    registry.register(DEVELOPMENT_LEAD_WORKFLOW);
    registry.register(SIMPLE_COMMIT);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
      registry,
      loop,
    });

    await engine.createTask({
      projectId: "p",
      workflowId: "development-lead",
      taskId: "alias-test",
      fields: { request: "alias smoke" },
    });
    await engine.idle();
    await leadAccept(engine, "alias-test");

    const task = await engine.getTask("alias-test");
    expect(task?.status).toBe("done");
    expect(task?.childIds).toHaveLength(1);
    expect((await engine.getTask(task!.childIds[0]!))?.status).toBe("done");
    });
  });

  test("depth propagates from parent to child subtask", async () => {
    const CHILD: WorkflowDef = {
      id: "child-depth", version: "1", name: "Child", description: "", fields: {},
      stages: [
        { id: "open", category: "in_progress", entry: { op: "always" } },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const PARENT: WorkflowDef = {
      id: "parent-depth", version: "1", name: "Parent", description: "", fields: {},
      stages: [
        { id: "split", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask"] },
        // Intermediate guard prevents vacuous pre-advance through childrenDone
        // before any child has been spawned (childrenDone is vacuously true
        // with zero children per ADR 0020).
        { id: "wait", category: "in_progress", entry: { op: "hasEvent", eventType: "subtask.created" } },
        { id: "review", category: "in_progress", entry: { op: "childrenDone" } },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const loop: LoopFactory = (ctx) =>
      scriptLoop(async (input) => {
        if (ctx.workflow.id === "child-depth") {
          await input.tools?.request_transition?.execute?.({}, {});
          return;
        }
        if (ctx.stageId === "split") {
          await input.tools?.create_subtask?.execute?.({ workflowId: "child-depth", input: "do part" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
          return;
        }
        await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
      });
    const engine = newEngine(loop, [CHILD, PARENT]);

    await engine.createTask({ projectId: "p", workflowId: "parent-depth", taskId: "P-depth" });
    await engine.idle();

    const parent = await engine.getTask("P-depth");
    expect(parent?.depth).toBe(0);
    const child = await engine.getTask(parent!.childIds[0]!);
    expect(child?.depth).toBe(1);
  });

  test("maxTeamDepth in a workflow prevents subtask creation beyond the cap", async () => {
    const CHILD: WorkflowDef = {
      id: "child-cap", version: "1", name: "Child", description: "", fields: {},
      // Also capped so a child spawned by CAPPED (depth 1) cannot itself spawn subtasks.
      maxTeamDepth: 1,
      stages: [
        // create_subtask is available so the test can prove the reducer rejects beyond maxTeamDepth.
        // request_transition also listed so the child can complete normally.
        { id: "open", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask", "request_transition"] },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const CAPPED: WorkflowDef = {
      id: "capped", version: "1", name: "Capped", description: "",
      maxTeamDepth: 1, // only root can create children; depth 1 cannot
      fields: {},
      stages: [
        { id: "split", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask"] },
        // Intermediate guard prevents vacuous pre-advance through childrenDone
        // (now vacuously true with zero children) before any child is spawned.
        { id: "wait", category: "in_progress", entry: { op: "hasEvent", eventType: "subtask.created" } },
        { id: "review", category: "in_progress", entry: { op: "childrenDone" } },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    let rejects: string[] = [];
    const loop: LoopFactory = (ctx) =>
      scriptLoop(async (input) => {
        if (ctx.workflow.id === "child-cap") {
          // child at depth 1 tries to spawn a subtask — should be rejected by maxTeamDepth
          if (ctx.stageId === "open") {
            await input.tools?.create_subtask?.execute?.({ workflowId: "general", input: "deep nested" }, {});
          }
          await input.tools?.request_transition?.execute?.({}, {});
          return;
        }
        if (ctx.stageId === "split") {
          await input.tools?.create_subtask?.execute?.({ workflowId: "child-cap", input: "first level" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
          return;
        }
        await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
      });
    const engine = newEngine(loop, [CHILD, CAPPED], {
      onReject: (i: { command: unknown; reason: string }) => rejects.push(i.reason),
    });

    await engine.createTask({ projectId: "p", workflowId: "capped", taskId: "C1" });
    await engine.idle();

    const parent = await engine.getTask("C1");
    expect(parent?.childIds).toHaveLength(1); // first subtask (depth 0 → 1) succeeds
    const child = await engine.getTask(parent!.childIds[0]!);
    expect(child?.depth).toBe(1);
    expect(child?.status).toBe("done"); // the child completed OK
    // The child at depth 1 tried to spawn a subtask at depth 2 but maxTeamDepth=1 rejects it
    expect(rejects.some((r) => /max team depth/.test(r))).toBe(true);
  });

  test("engine-level maxTeamDepth bounds workflows without explicit caps", async () => {
    const CHILD: WorkflowDef = {
      id: "child-engine", version: "1", name: "Child", description: "", fields: {},
      // No maxTeamDepth — bounded by the engine-level default instead.
      stages: [
        { id: "open", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask", "request_transition"] },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const PARENT: WorkflowDef = {
      id: "parent-engine", version: "1", name: "Parent", description: "", fields: {},
      // No maxTeamDepth — bounded by the engine-level default.
      stages: [
        { id: "split", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask"] },
        { id: "wait", category: "in_progress", entry: { op: "hasEvent", eventType: "subtask.created" } },
        { id: "review", category: "in_progress", entry: { op: "childrenDone" } },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    let rejects: string[] = [];
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    registry.register(CHILD);
    registry.register(PARENT);
    const loop: LoopFactory = (ctx) =>
      scriptLoop(async (input) => {
        if (ctx.workflow.id === "child-engine") {
          // child at depth 1 tries to spawn — rejected by engine-level maxTeamDepth=1
          if (ctx.stageId === "open") {
            await input.tools?.create_subtask?.execute?.({ workflowId: "general", input: "nested" }, {});
          }
          await input.tools?.request_transition?.execute?.({}, {});
          return;
        }
        if (ctx.stageId === "split") {
          await input.tools?.create_subtask?.execute?.({ workflowId: "child-engine", input: "first level" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
          return;
        }
        await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
      });
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry,
      maxTeamDepth: 1, // engine-level cap: only root can spawn
      loop,
      hooks: { onReject: (i: { reason: string }) => rejects.push(i.reason) },
    });

    await engine.createTask({ projectId: "p", workflowId: "parent-engine", taskId: "E1" });
    await engine.idle();

    const parent = await engine.getTask("E1");
    expect(parent?.childIds).toHaveLength(1); // first subtask succeeds
    const child = await engine.getTask(parent!.childIds[0]!);
    expect(child?.depth).toBe(1);
    expect(child?.status).toBe("done");
    // The child at depth 1 tried to spawn but engine-level maxTeamDepth=1 rejects it
    expect(rejects.some((r) => /max team depth/.test(r))).toBe(true);
  });

  test("a 3rd-tier create_subtask is refused by maxTeamDepth (default: 2)", async () => {
    // Root (depth 0) creates child (depth 1) ✓
    // Child (depth 1) creates grandchild (depth 2) ✓
    // Grandchild (depth 2) tries to create great-grandchild (depth 3) ✗
    const TIER: WorkflowDef = {
      id: "tier",
      version: "1",
      name: "Tier",
      description: "",
      // Default maxTeamDepth=2: three tiers allowed (0→1→2), the 4th (2→3) refused
      maxTeamDepth: 2,
      fields: {},
      stages: [
        { id: "open", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask", "request_transition"] },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const rejects: string[] = [];
    const loop: LoopFactory = (ctx) =>
      scriptLoop(async (input) => {
        if (ctx.stageId === "open") {
          if (ctx.task.depth < 2) {
            // Depth 0 (root) or 1 (child): allowed to spawn
            await input.tools?.create_subtask?.execute?.({ workflowId: "tier", input: "sub" }, {});
          } else {
            // Depth 2 (grandchild, 3rd tier): tries and is rejected by maxTeamDepth
            await input.tools?.create_subtask?.execute?.({ workflowId: "general", input: "deep" }, {});
          }
        }
        await input.tools?.request_transition?.execute?.({}, {});
      });
    const engine = newEngine(loop, [TIER], {
      onReject: (i: { reason: string }) => rejects.push(i.reason),
    });

    await engine.createTask({ projectId: "p", workflowId: "tier", taskId: "T0" });
    await engine.idle();

    const root = await engine.getTask("T0");
    expect(root?.childIds).toHaveLength(1);
    const child = await engine.getTask(root!.childIds[0]!);
    expect(child?.childIds).toHaveLength(1);
    const grandchild = await engine.getTask(child!.childIds[0]!);
    expect(grandchild?.status).toBe("done");
    // Grandchild's attempt to spawn at depth 3 was rejected by max team depth
    expect(rejects.some((r) => /max team depth/.test(r))).toBe(true);
  });
});
