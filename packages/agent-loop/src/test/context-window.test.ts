import { describe, expect, test } from "vitest";
import { contextFields, resolveContextWindow } from "../core/context-window";

describe("resolveContextWindow", () => {
  test("explicit override always wins", () => {
    expect(resolveContextWindow("claude-sonnet-4-6", 50_000)).toBe(50_000);
    expect(resolveContextWindow("totally-unknown", 12_345)).toBe(12_345);
  });

  test("known models resolve by substring", () => {
    expect(resolveContextWindow("claude-opus-4-6", undefined)).toBe(200_000);
    expect(resolveContextWindow("deepseek-chat", undefined)).toBe(128_000);
    expect(resolveContextWindow("gpt-5.1", undefined)).toBe(400_000);
  });

  test("unknown model returns undefined (never guesses)", () => {
    expect(resolveContextWindow("some-random-model", undefined)).toBeUndefined();
    expect(resolveContextWindow(undefined, undefined)).toBeUndefined();
  });

  test("zero / negative override is ignored, falls back to table", () => {
    expect(resolveContextWindow("claude-sonnet-4-6", 0)).toBe(200_000);
  });
});

describe("contextFields", () => {
  test("computes usedRatio when window known", () => {
    expect(contextFields(50_000, 200_000)).toEqual({
      contextWindow: 200_000,
      usedRatio: 0.25,
    });
  });

  test("empty object when window unknown (spread is a no-op)", () => {
    expect(contextFields(50_000, undefined)).toEqual({});
    expect(contextFields(50_000, 0)).toEqual({});
  });
});
