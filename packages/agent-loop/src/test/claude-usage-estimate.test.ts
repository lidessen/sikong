import { describe, expect, it } from "vitest";
import { fillEstimatedOutput } from "../adapters/claude";

const base = {
  inputTokens: 1000,
  outputTokens: 0,
  totalTokens: 1000,
  cacheReadTokens: 500,
  cacheCreationTokens: 0,
};

describe("fillEstimatedOutput (DeepSeek cancel-path output recovery)", () => {
  it("estimates output from streamed text + thinking when output is 0", () => {
    // 100 text chars + 300 thinking chars = 400 chars => ceil(400/4) = 100 tokens.
    const u = fillEstimatedOutput(base, {
      streamedText: "x".repeat(100),
      streamedThinking: "y".repeat(300),
    });
    expect(u.outputTokens).toBe(100);
    // total is recomputed including the estimated output.
    expect(u.totalTokens).toBe(1000 + 100 + 500 + 0);
  });

  it("counts reasoning tokens too (thinking dominates output under max effort)", () => {
    const u = fillEstimatedOutput(base, { streamedText: "", streamedThinking: "z".repeat(4000) });
    expect(u.outputTokens).toBe(1000); // 4000/4
  });

  it("never overrides a real reported output value", () => {
    const withReal = { ...base, outputTokens: 47, totalTokens: 1547 };
    const u = fillEstimatedOutput(withReal, {
      streamedText: "x".repeat(1000),
      streamedThinking: "",
    });
    expect(u).toEqual(withReal); // untouched
  });

  it("leaves usage untouched when there was no streamed content", () => {
    const u = fillEstimatedOutput(base, { streamedText: "", streamedThinking: "" });
    expect(u).toEqual(base);
  });
});
