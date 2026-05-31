import { describe, expect, test } from "vitest";
import { evalGuard, type GuardEnv } from "./guard";
import type { Guard } from "./types";

const env = (over: Partial<GuardEnv> = {}): GuardEnv => ({
  fields: {},
  eventTypes: new Set(),
  children: [],
  ...over,
});

describe("evalGuard", () => {
  test("always / never", () => {
    expect(evalGuard({ op: "always" }, env())).toBe(true);
    expect(evalGuard({ op: "never" }, env())).toBe(false);
  });

  test("field comparisons", () => {
    expect(evalGuard({ op: "field", field: "x", cmp: "eq", value: 1 }, env({ fields: { x: 1 } }))).toBe(true);
    expect(evalGuard({ op: "field", field: "x", cmp: "eq", value: 1 }, env({ fields: { x: 2 } }))).toBe(false);
    expect(evalGuard({ op: "field", field: "x", cmp: "ne", value: 1 }, env({ fields: { x: 2 } }))).toBe(true);
    expect(evalGuard({ op: "field", field: "n", cmp: "gte", value: 3 }, env({ fields: { n: 3 } }))).toBe(true);
    expect(evalGuard({ op: "field", field: "n", cmp: "gt", value: 3 }, env({ fields: { n: 3 } }))).toBe(false);
    expect(evalGuard({ op: "field", field: "s", cmp: "in", value: ["a", "b"] }, env({ fields: { s: "b" } }))).toBe(true);
  });

  test("exists distinguishes unset from falsy", () => {
    expect(evalGuard({ op: "field", field: "x", cmp: "exists" }, env({ fields: { x: false } }))).toBe(true);
    expect(evalGuard({ op: "field", field: "x", cmp: "exists" }, env())).toBe(false);
  });

  test("ordering fails closed on non-numbers", () => {
    expect(evalGuard({ op: "field", field: "s", cmp: "gt", value: 3 }, env({ fields: { s: "x" } }))).toBe(false);
  });

  test("hasEvent reads current-stage event types", () => {
    const g: Guard = { op: "hasEvent", eventType: "transition.requested" };
    expect(evalGuard(g, env({ eventTypes: new Set(["transition.requested"]) }))).toBe(true);
    expect(evalGuard(g, env())).toBe(false);
  });

  test("childrenDone needs ≥1 child, all terminal (cancelled counts)", () => {
    expect(evalGuard({ op: "childrenDone" }, env({ children: [] }))).toBe(false);
    expect(evalGuard({ op: "childrenDone" }, env({ children: ["done", "cancelled"] }))).toBe(true);
    expect(evalGuard({ op: "childrenDone" }, env({ children: ["done", "in_progress"] }))).toBe(false);
  });

  test("childrenSucceeded requires all done — a cancelled child fails it", () => {
    expect(evalGuard({ op: "childrenSucceeded" }, env({ children: ["done", "done"] }))).toBe(true);
    expect(evalGuard({ op: "childrenSucceeded" }, env({ children: ["done", "cancelled"] }))).toBe(false);
    expect(evalGuard({ op: "childrenSucceeded" }, env({ children: [] }))).toBe(false);
  });

  test("and / or / not compose", () => {
    const f: Guard = { op: "field", field: "x", cmp: "eq", value: 1 };
    expect(evalGuard({ op: "and", all: [f, { op: "always" }] }, env({ fields: { x: 1 } }))).toBe(true);
    expect(evalGuard({ op: "and", all: [f, { op: "never" }] }, env({ fields: { x: 1 } }))).toBe(false);
    expect(evalGuard({ op: "or", any: [f, { op: "never" }] }, env({ fields: { x: 9 } }))).toBe(false);
    expect(evalGuard({ op: "not", guard: { op: "never" } }, env())).toBe(true);
  });
});
