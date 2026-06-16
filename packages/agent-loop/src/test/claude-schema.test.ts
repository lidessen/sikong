import { describe, expect, test } from "vitest";
import * as zod from "zod";
import { jsonSchemaToZodRawShape, mapClaudeMessage } from "../adapters/claude";

const z = ((zod as unknown as { z?: typeof zod }).z ?? zod) as typeof zod;

describe("Claude adapter tool schemas", () => {
  test("converts JSON Schema object properties to a Zod raw shape", () => {
    const shape = jsonSchemaToZodRawShape({
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
