import { describe, expect, test } from "vitest";
import * as zod from "zod";
import { jsonSchemaToZodRawShape } from "../adapters/claude";

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
    expect(z.object(shape).safeParse({ field: "ready", value: false, reason: "done" }).success).toBe(true);
  });
});
