import { describe, expect, test } from "vitest";
import * as zod from "zod";
import { CLAUDE_SETTING_SOURCES, claudeToolInputShape, mapClaudeMessage } from "../adapters/claude";

const z = ((zod as unknown as { z?: typeof zod }).z ?? zod) as typeof zod;

describe("Claude adapter tool schemas", () => {
  test("adapts JSON Schema object properties to the Claude tool raw shape", () => {
    const shape = claudeToolInputShape({
      type: "object",
      properties: {
        field: { type: "string", enum: ["summary", "ready"] },
        value: { description: "Any value matching the workflow field type." },
        reason: { type: "string" },
      },
      required: ["field", "value"],
      additionalProperties: false,
    });

    const parsed = z.object(shape).safeParse({ field: "summary", value: true });
    expect(parsed.success).toBe(true);
    expect(z.object(shape).safeParse({ field: "missing", value: true }).success).toBe(false);
    expect(z.object(shape).safeParse({ field: "ready" }).success).toBe(false);
    expect(
      z.object(shape).safeParse({ field: "ready", value: false, reason: "done" }).success,
    ).toBe(true);
  });

  test("uses Zod JSON Schema conversion for refs and array bounds", () => {
    const shape = claudeToolInputShape({
      type: "object",
      properties: {
        mode: { $ref: "#/$defs/PlanGroupMode" },
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              requires_prior_results: { type: "boolean" },
            },
            required: ["requires_prior_results"],
            additionalProperties: false,
          },
        },
      },
      required: ["mode", "items"],
      additionalProperties: false,
      $defs: {
        PlanGroupMode: { type: "string", enum: ["stage", "parallel"] },
      },
    });

    const schema = z.object(shape);

    expect(
      schema.safeParse({ mode: "parallel", items: [{ requires_prior_results: false }] }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ mode: "wait", items: [{ requires_prior_results: false }] }).success,
    ).toBe(false);
    expect(schema.safeParse({ mode: "parallel", items: [] }).success).toBe(false);
    expect(schema.safeParse({ mode: "parallel", items: [{}] }).success).toBe(false);
  });
});

describe("Claude adapter message mapping", () => {
  test("does not duplicate tool end events already emitted by in-process tools", () => {
    const toolNames = new Map([["toolu_1", "mcp__agent_loop_tools__finish"]]);
    const emitted = new Set(["toolu_1"]);
    const mapped = mapClaudeMessage(
      {
        type: "user",
        parent_tool_use_id: "toolu_1",
        tool_use_result: { ok: true },
      } as never,
      toolNames,
      { streamedText: "", streamedThinking: "" },
      emitted,
    );

    expect(mapped.events).toEqual([]);
  });
});

describe("Claude adapter settings isolation", () => {
  test("does not load user, project, or local Claude settings", () => {
    expect(CLAUDE_SETTING_SOURCES).toEqual([]);
  });
});
