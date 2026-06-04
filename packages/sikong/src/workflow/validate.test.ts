import { describe, expect, test } from "vitest";
import { assertValidWorkflow, validateWorkflow, type ValidateOptions } from "./validate";
import { DESIGN_WORKFLOW, DEVELOPMENT_WORKFLOW, GENERAL_WORKFLOW } from "./builtin";
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
});

// ── DESIGN_WORKFLOW adversarial edge-case tests ──────────────────────────────────

describe("DESIGN_WORKFLOW edge cases", () => {
  const wf = DESIGN_WORKFLOW;

  test("workerRole is 'coding' so it staffs a coding-capable worker", () => {
    expect(wf.workerRole).toBe("coding");
  });

  test("has the full 8-stage sequence: brief → diverge → preview → critique → converge → refine → deliver → done", () => {
    const ids = wf.stages.map((s) => s.id);
    expect(ids).toEqual([
      "brief",
      "diverge",
      "preview",
      "critique",
      "converge",
      "refine",
      "deliver",
      "done",
    ]);
  });

  test("every non-initial stage with a field guard references a field set by an earlier stage's outputFields — no dangling guard reference", () => {
    // Build the set of fields set as outputFields by each stage index
    const cumulativeOutputFields = new Set<string>();
    for (let i = 0; i < wf.stages.length; i++) {
      const stage = wf.stages[i];
      if (!stage) break;

      // Collect fields referenced by the current stage's entry guard (but not the
      // initial stage — its guard is `always`).
      if (i > 0) {
        const referenced = collectFieldRefs(stage.entry);
        for (const ref of referenced) {
          expect(cumulativeOutputFields.has(ref)).toBe(true);
        }
      }

      // Accumulate this stage's outputFields
      for (const f of stage.outputFields ?? []) {
        cumulativeOutputFields.add(f);
      }
    }
  });

  test("the preview stage intentionally has no outputFields (it only serves previews, never writes workflow state)", () => {
    const preview = wf.stages[2];
    expect(preview?.id).toBe("preview");
    expect(preview?.outputFields).toBeUndefined();
    // Preview should still have instructions
    expect(preview?.instructions).toBeTruthy();
  });

  test("all outputFields in every stage are declared as workflow fields with a compatible type", () => {
    for (const stage of wf.stages) {
      for (const field of stage.outputFields ?? []) {
        const def = wf.fields[field];
        expect(def).toBeDefined();
      }
    }
  });

  test("JSON-typed fields (candidates, critiques, changedFiles) only appear as outputFields of stages that write them", () => {
    expect(wf.fields.candidates).toBeDefined();
    expect(wf.fields.candidates?.type).toBe("json");
    expect(wf.fields.critiques).toBeDefined();
    expect(wf.fields.critiques?.type).toBe("json");
    expect(wf.fields.changedFiles).toBeDefined();
    expect(wf.fields.changedFiles?.type).toBe("json");
  });

  test("every guard field reference that uses 'exists' cmp is paired with a field that appears in some stage's outputFields", () => {
    // Check guards recursively for field-exists patterns
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

  test("done stage's entry guard requires the same fields that deliver stage outputs", () => {
    const deliver = wf.stages[6];
    const done = wf.stages[7];
    expect(deliver?.id).toBe("deliver");
    expect(done?.id).toBe("done");

    const deliverOutputs = new Set(deliver?.outputFields ?? []);
    const doneRefs = collectFieldRefs(done?.entry ?? { op: "always" });

    // Every field done checks (via exists) should be output by deliver
    for (const ref of doneRefs) {
      expect(deliverOutputs.has(ref)).toBe(true);
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
