import { describe, expect, test } from "vitest";
import { assertValidWorkflow, validateWorkflow, type ValidateOptions } from "./validate";
import { DESIGN_WORKFLOW, DEVELOPMENT_WORKFLOW, GENERAL_WORKFLOW, RELEASE_WORKFLOW, VISUAL_DESIGN_WORKFLOW } from "./builtin";
import { WorkflowValidationError } from "./errors";
import type { Guard, WorkflowDef } from "./types";

const codes = (wf: WorkflowDef, opts?: ValidateOptions) =>
  validateWorkflow(wf, opts).map((i) => i.code);

describe("validateWorkflow", () => {
  test("the builtin GENERAL workflow is valid", () => {
    expect(validateWorkflow(GENERAL_WORKFLOW)).toEqual([]);
  });

  test("the builtin DEVELOPMENT workflow is valid", () => {
    expect(validateWorkflow(DEVELOPMENT_WORKFLOW)).toEqual([]);
  });

  test("the builtin DESIGN workflow is valid", () => {
    expect(validateWorkflow(DESIGN_WORKFLOW)).toEqual([]);
  });

  test("the builtin VISUAL DESIGN workflow is valid", () => {
    expect(validateWorkflow(VISUAL_DESIGN_WORKFLOW)).toEqual([]);
  });

  test("the builtin RELEASE workflow is valid", () => {
    expect(validateWorkflow(RELEASE_WORKFLOW)).toEqual([]);
  });

  test("flags a workflow with no terminal (done) stage", () => {
    const wf: WorkflowDef = {
      id: "x", version: "1", name: "X", description: "", fields: {},
      stages: [{ id: "a", category: "in_progress", entry: { op: "always" } }],
    };
    expect(codes(wf)).toContain("no-terminal-stage");
  });

  test("flags duplicate stage ids", () => {
    const wf: WorkflowDef = {
      id: "x", version: "1", name: "X", description: "", fields: {},
      stages: [
        { id: "a", category: "todo", entry: { op: "always" } },
        { id: "a", category: "done", entry: { op: "always" } },
      ],
    };
    expect(codes(wf)).toContain("duplicate-stage-id");
  });

  test("flags a guard referencing an undeclared field", () => {
    const wf: WorkflowDef = {
      id: "x", version: "1", name: "X", description: "", fields: {},
      stages: [
        { id: "a", category: "todo", entry: { op: "always" } },
        { id: "b", category: "done", entry: { op: "field", field: "ghost", cmp: "eq", value: 1 } },
      ],
    };
    expect(codes(wf)).toContain("guard-unknown-field");
  });

  test("flags an unreachable (never) non-initial stage", () => {
    const wf: WorkflowDef = {
      id: "x", version: "1", name: "X", description: "", fields: {},
      stages: [
        { id: "a", category: "todo", entry: { op: "always" } },
        { id: "b", category: "done", entry: { op: "never" } },
      ],
    };
    expect(codes(wf)).toContain("unreachable-stage");
  });

  test("flags an enum field without values", () => {
    const wf: WorkflowDef = {
      id: "x", version: "1", name: "X", description: "",
      fields: { k: { type: "enum", enum: [], description: "" } },
      stages: [{ id: "a", category: "done", entry: { op: "always" } }],
    };
    expect(codes(wf)).toContain("enum-without-values");
  });

  test("resolves stage tool refs against knownTools when provided", () => {
    const wf: WorkflowDef = {
      id: "x", version: "1", name: "X", description: "", fields: {},
      stages: [{ id: "a", category: "done", entry: { op: "always" }, tools: ["ghost_tool"] }],
    };
    expect(codes(wf, { knownTools: new Set(["real_tool"]) })).toContain("unknown-tool");
    expect(codes(wf, { knownTools: new Set(["ghost_tool"]) })).not.toContain("unknown-tool");
  });

  test("flags stage output fields that are not declared", () => {
    const wf: WorkflowDef = {
      id: "x", version: "1", name: "X", description: "",
      fields: { summary: { type: "string", description: "" } },
      stages: [{ id: "a", category: "done", entry: { op: "always" }, outputFields: ["ghost"] }],
    };
    expect(codes(wf)).toContain("unknown-output-field");
  });

  test("flags missing fields/stages instead of throwing a TypeError on a malformed def", () => {
    const bare = { id: "x", version: "1", name: "X" } as unknown as WorkflowDef;
    expect(codes(bare)).toEqual(expect.arrayContaining(["missing-fields", "missing-stages"]));
    const noStages = { id: "x", version: "1", name: "X", fields: {} } as unknown as WorkflowDef;
    expect(codes(noStages)).toContain("missing-stages");
    const noFields = {
      id: "x",
      version: "1",
      name: "X",
      stages: [{ id: "a", category: "done", entry: { op: "always" } }],
    } as unknown as WorkflowDef;
    expect(codes(noFields)).toContain("missing-fields");
  });

  test("assertValidWorkflow throws WorkflowValidationError", () => {
    const wf: WorkflowDef = {
      id: "bad", version: "1", name: "Bad", description: "", fields: {},
      stages: [{ id: "a", category: "in_progress", entry: { op: "always" } }],
    };
    expect(() => assertValidWorkflow(wf)).toThrow(WorkflowValidationError);
  });

  test("rejects maxTeamDepth of 0 (must be >= 1 per ADR 0020)", () => {
    const wf: WorkflowDef = {
      id: "x", version: "1", name: "X", description: "", fields: {},
      maxTeamDepth: 0,
      stages: [
        { id: "a", category: "todo", entry: { op: "always" } },
        { id: "done", category: "done", entry: { op: "always" } },
      ],
    };
    expect(codes(wf)).toContain("invalid-max-team-depth");
  });

  test("accepts valid maxTeamDepth positive value", () => {
    const wf: WorkflowDef = {
      id: "x", version: "1", name: "X", description: "", fields: {},
      maxTeamDepth: 3,
      stages: [
        { id: "a", category: "todo", entry: { op: "always" } },
        { id: "done", category: "done", entry: { op: "always" } },
      ],
    };
    expect(codes(wf)).not.toContain("invalid-max-team-depth");
  });

  test("rejects negative maxTeamDepth", () => {
    const wf: WorkflowDef = {
      id: "x", version: "1", name: "X", description: "", fields: {},
      maxTeamDepth: -1,
      stages: [
        { id: "a", category: "todo", entry: { op: "always" } },
        { id: "done", category: "done", entry: { op: "always" } },
      ],
    };
    expect(codes(wf)).toContain("invalid-max-team-depth");
  });

  test("rejects non-integer maxTeamDepth", () => {
    const wf: WorkflowDef = {
      id: "x", version: "1", name: "X", description: "", fields: {},
      maxTeamDepth: 2.5,
      stages: [
        { id: "a", category: "todo", entry: { op: "always" } },
        { id: "done", category: "done", entry: { op: "always" } },
      ],
    };
    expect(codes(wf)).toContain("invalid-max-team-depth");
  });
});

// ── DESIGN_WORKFLOW (v4, generic architectural/technical design) adversarial edge-case tests ─────

describe("DESIGN_WORKFLOW edge cases (v4, generic design)", () => {
  const wf = DESIGN_WORKFLOW;

  test("has no workerRole (any worker can do design)", () => {
    expect(wf.workerRole).toBeUndefined();
  });

  test("has the full 4-stage sequence: design → document → review → done", () => {
    const ids = wf.stages.map((s) => s.id);
    expect(ids).toEqual([
      "design",
      "document",
      "review",
      "done",
    ]);
  });

  test("every non-initial stage with a field guard references a field set by an earlier stage's outputFields — no dangling guard reference", () => {
    const cumulativeOutputFields = new Set<string>();
    for (let i = 0; i < wf.stages.length; i++) {
      const stage = wf.stages[i];
      if (!stage) break;

      if (i > 0) {
        const referenced = collectFieldRefs(stage.entry);
        for (const ref of referenced) {
          expect(cumulativeOutputFields.has(ref)).toBe(true);
        }
      }

      for (const f of stage.outputFields ?? []) {
        cumulativeOutputFields.add(f);
      }
    }
  });

  test("design stage outputs are (design, alternatives) — the key design artifacts", () => {
    const design = wf.stages[0];
    expect(design?.id).toBe("design");
    expect(design?.outputFields).toContain("design");
    expect(design?.outputFields).toContain("alternatives");
  });

  test("document stage has no outputFields (purely side-effectful, writes to files)", () => {
    const doc = wf.stages[1];
    expect(doc?.id).toBe("document");
    expect(doc?.outputFields).toEqual([]);
  });

  test("review stage outputs summary", () => {
    const review = wf.stages[2];
    expect(review?.id).toBe("review");
    expect(review?.outputFields).toContain("summary");
  });

  test("all outputFields in every stage are declared as workflow fields with a compatible type", () => {
    for (const stage of wf.stages) {
      for (const field of stage.outputFields ?? []) {
        const def = wf.fields[field];
        expect(def).toBeDefined();
      }
    }
  });

  test("every guard field reference that uses 'exists' cmp is paired with a field that appears in some stage's outputFields", () => {
    const expectedFields = new Set<string>();
    for (const stage of wf.stages) {
      for (const f of stage.outputFields ?? []) {
        expectedFields.add(f);
      }
    }
    // request is input-only — intentionally not in outputFields
    expectedFields.delete("request");

    for (const stage of wf.stages) {
      const refs = collectAllFieldGuards(stage.entry);
      for (const { field, cmp } of refs) {
        if (cmp === "exists") {
          expect(expectedFields.has(field)).toBe(true);
        }
      }
    }
  });

  test("done stage's entry guard references fields set by earlier stages (design from design stage, summary from review)", () => {
    const done = wf.stages[3];
    expect(done?.id).toBe("done");

    // Collect output fields from all non-terminal stages
    const earlierOutputs = new Set<string>();
    for (let i = 0; i < wf.stages.length - 1; i++) {
      const stage = wf.stages[i];
      if (!stage) break;
      for (const f of stage.outputFields ?? []) {
        earlierOutputs.add(f);
      }
    }

    const doneRefs = collectFieldRefs(done?.entry ?? { op: "always" });
    for (const ref of doneRefs) {
      expect(earlierOutputs.has(ref)).toBe(true);
    }
  });
});

/** Collect field names referenced by an {@link op: "field"} guard within a nested guard tree. */
function collectFieldRefs(guard: Guard): string[] {
  const out: string[] = [];
  function walk(g: Guard): void {
    if (g.op === "field") {
      out.push(g.field);
    } else if (g.op === "and") {
      g.all.forEach(walk);
    } else if (g.op === "or") {
      g.any.forEach(walk);
    } else if (g.op === "not") {
      walk(g.guard);
    }
    // always / never / hasEvent / childrenDone / childrenSucceeded => no field refs
  }
  walk(guard);
  return out;
}

/** Collect all field-guard entries (field name + cmp) from a nested guard tree. */
function collectAllFieldGuards(guard: Guard): Array<{ field: string; cmp: string }> {
  const out: Array<{ field: string; cmp: string }> = [];
  function walk(g: Guard): void {
    if (g.op === "field") {
      out.push({ field: g.field, cmp: g.cmp });
    } else if (g.op === "and") {
      g.all.forEach(walk);
    } else if (g.op === "or") {
      g.any.forEach(walk);
    } else if (g.op === "not") {
      walk(g.guard);
    }
  }
  walk(guard);
  return out;
}

// ── RELEASE_WORKFLOW adversarial edge-case tests ──────────────────────────────

describe("RELEASE_WORKFLOW edge cases", () => {
  const wf = RELEASE_WORKFLOW;

  test("workerRole is 'coding' so it staffs a coding-capable worker", () => {
    expect(wf.workerRole).toBe("coding");
  });

  test("has the full 7-stage sequence: assess → gate → prepare → approve → publish → confirm → done", () => {
    const ids = wf.stages.map((s) => s.id);
    expect(ids).toEqual([
      "assess",
      "gate",
      "prepare",
      "approve",
      "publish",
      "confirm",
      "done",
    ]);
  });

  test("every non-initial stage with a field guard references a field set by an earlier stage's outputFields — no dangling guard reference", () => {
    const cumulativeOutputFields = new Set<string>();
    for (let i = 0; i < wf.stages.length; i++) {
      const stage = wf.stages[i];
      if (!stage) break;

      if (i > 0) {
        const refs = collectAllFieldGuards(stage.entry);
        for (const { field, cmp } of refs) {
          if (cmp !== "exists") continue; // eq/ne guards reference external fields (e.g. approved)
          expect(cumulativeOutputFields.has(field)).toBe(true);
        }
      }

      for (const f of stage.outputFields ?? []) {
        cumulativeOutputFields.add(f);
      }
    }
  });

  test("all outputFields in every stage are declared as workflow fields with a compatible type", () => {
    for (const stage of wf.stages) {
      for (const field of stage.outputFields ?? []) {
        const def = wf.fields[field];
        expect(def).toBeDefined();
      }
    }
  });

  test("the `approved` field is NOT in any stage's outputFields (lead-only gate)", () => {
    for (const stage of wf.stages) {
      expect(stage.outputFields ?? []).not.toContain("approved");
    }
  });

  test("JSON-typed fields (releasePlan, gate, published, verification) only appear as outputFields of stages that write them", () => {
    expect(wf.fields.releasePlan).toBeDefined();
    expect(wf.fields.releasePlan?.type).toBe("json");
    expect(wf.fields.gate).toBeDefined();
    expect(wf.fields.gate?.type).toBe("json");
    expect(wf.fields.published).toBeDefined();
    expect(wf.fields.published?.type).toBe("json");
    expect(wf.fields.verification).toBeDefined();
    expect(wf.fields.verification?.type).toBe("json");
  });

  test("every guard field reference that uses 'exists' cmp is paired with a field that appears in some stage's outputFields", () => {
    const expectedFields = new Set<string>();
    for (const stage of wf.stages) {
      for (const f of stage.outputFields ?? []) {
        expectedFields.add(f);
      }
    }
    // request and releaseRef are input-only — intentionally not in outputFields
    expectedFields.delete("request");
    expectedFields.delete("releaseRef");

    for (const stage of wf.stages) {
      const refs = collectAllFieldGuards(stage.entry);
      for (const { field, cmp } of refs) {
        if (cmp === "exists") {
          expect(expectedFields.has(field)).toBe(true);
        }
      }
    }
  });

  test("done stage's entry guard requires the same fields that confirm stage outputs", () => {
    const confirm = wf.stages[5];
    const done = wf.stages[6];
    expect(confirm?.id).toBe("confirm");
    expect(done?.id).toBe("done");

    const confirmOutputs = new Set(confirm?.outputFields ?? []);
    const doneRefs = collectFieldRefs(done?.entry ?? { op: "always" });

    for (const ref of doneRefs) {
      expect(confirmOutputs.has(ref)).toBe(true);
    }
  });

  test("publish and confirm stages enable create_subtask for fan-out", () => {
    const publish = wf.stages[4];
    const confirm = wf.stages[5];
    expect(publish?.id).toBe("publish");
    expect(confirm?.id).toBe("confirm");

    expect(publish?.tools).toContain("create_subtask");
    expect(confirm?.tools).toContain("create_subtask");
  });

  test("the publish stage guards on approved=true (eq comparator)", () => {
    const publish = wf.stages[4];
    expect(publish?.id).toBe("publish");

    // Walk the entry guard tree looking for the approved=true constraint
    const fieldGuards = collectAllFieldGuards(publish?.entry ?? { op: "always" });
    const approvedGuard = fieldGuards.find((g) => g.field === "approved");
    expect(approvedGuard).toBeDefined();
    expect(approvedGuard?.cmp).toBe("eq");
  });
});
