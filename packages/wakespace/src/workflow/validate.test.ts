import { describe, expect, test } from "vitest";
import { assertValidWorkflow, validateWorkflow, type ValidateOptions } from "./validate";
import { DEVELOPMENT_WORKFLOW, GENERAL_WORKFLOW } from "./builtin";
import { WorkflowValidationError } from "./errors";
import type { WorkflowDef } from "./types";

const codes = (wf: WorkflowDef, opts?: ValidateOptions) =>
  validateWorkflow(wf, opts).map((i) => i.code);

describe("validateWorkflow", () => {
  test("the builtin GENERAL workflow is valid", () => {
    expect(validateWorkflow(GENERAL_WORKFLOW)).toEqual([]);
  });

  test("the builtin DEVELOPMENT workflow is valid", () => {
    expect(validateWorkflow(DEVELOPMENT_WORKFLOW)).toEqual([]);
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
