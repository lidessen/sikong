// Lead-authored spec for ADR 0028 (target-aware design workflow). The implementing
// worker must make these pass and MUST NOT modify this file.
import { describe, expect, test } from "vitest";
import { VISUAL_DESIGN_WORKFLOW } from "./builtin";
import { assertValidWorkflow } from "./validate";

describe("design workflow is target-aware (ADR 0028)", () => {
  test("declares a `target` field", () => {
    expect(VISUAL_DESIGN_WORKFLOW.fields["target"]).toBeDefined();
  });

  test("the frame stage captures target", () => {
    const frame = VISUAL_DESIGN_WORKFLOW.stages.find((s) => s.id === "frame");
    expect(frame?.outputFields ?? []).toContain("target");
  });

  test("the assemble stage handles BOTH web (semajsx) and native (swiftui)", () => {
    const assemble = VISUAL_DESIGN_WORKFLOW.stages.find((s) => s.id === "assemble");
    const instr = (assemble?.instructions ?? "").toLowerCase();
    expect(instr).toMatch(/swiftui|swift/);
    expect(instr).toMatch(/semajsx/);
  });

  test("the review stage gates native targets on `swift build`", () => {
    const review = VISUAL_DESIGN_WORKFLOW.stages.find((s) => s.id === "review");
    expect((review?.instructions ?? "").toLowerCase()).toMatch(/swift build/);
  });

  test("is a valid workflow and the version is bumped past design@2", () => {
    expect(() => assertValidWorkflow(VISUAL_DESIGN_WORKFLOW)).not.toThrow();
    expect(Number(VISUAL_DESIGN_WORKFLOW.version)).toBeGreaterThanOrEqual(3);
  });
});
