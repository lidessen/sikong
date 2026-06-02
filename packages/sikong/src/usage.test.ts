import { describe, expect, test } from "vitest";
import type { ChronicleEntry } from "./store/types";
import { renderUsage, summarizeUsage, wakeCostUsd } from "./usage";

const NOW = 1_700_000_000_000;
const H = 60 * 60 * 1000;

function wakeEntry(
  seq: number,
  ts: number,
  taskId: string,
  usage: Record<string, unknown>,
): ChronicleEntry {
  return { seq, ts, type: "wake.end", taskId, summary: "wake done", data: { usage } };
}

describe("wakeCostUsd", () => {
  test("prices a known token-billed model to a positive number", () => {
    const cost = wakeCostUsd({
      model: "deepseek-chat",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      billingMode: "token",
    });
    expect(cost).toBeGreaterThan(0);
  });

  test("is undefined for a subscription worker ($ not applicable)", () => {
    expect(
      wakeCostUsd({
        model: "claude-sonnet-4-6",
        inputTokens: 1000,
        outputTokens: 1000,
        totalTokens: 2000,
        billingMode: "subscription",
      }),
    ).toBeUndefined();
  });

  test("is undefined for an unknown model price (never guessed)", () => {
    expect(
      wakeCostUsd({
        model: "totally-made-up-model-xyz",
        inputTokens: 1000,
        outputTokens: 1000,
        totalTokens: 2000,
        billingMode: "token",
      }),
    ).toBeUndefined();
  });

  test("cache-read is cheaper than the same tokens as fresh input", () => {
    const fresh = wakeCostUsd({
      model: "deepseek-chat",
      inputTokens: 1_000_000,
      outputTokens: 0,
      totalTokens: 1_000_000,
      billingMode: "token",
    })!;
    const cached = wakeCostUsd({
      model: "deepseek-chat",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      totalTokens: 1_000_000,
      billingMode: "token",
    })!;
    expect(cached).toBeLessThan(fresh);
  });
});

describe("summarizeUsage", () => {
  const entries: ChronicleEntry[] = [
    wakeEntry(1, NOW - 1 * H, "t1", {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 20,
      model: "deepseek-chat",
      provider: "deepseek",
      billingMode: "token",
    }),
    wakeEntry(2, NOW - 2 * H, "t1", {
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      model: "deepseek-chat",
      provider: "deepseek",
      billingMode: "token",
    }),
    // a subscription wake — counted in tokens, excluded from $
    wakeEntry(3, NOW - 3 * H, "t2", {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      model: "claude-sonnet-4-6",
      billingMode: "subscription",
    }),
    // old wake — outside the 5h window, inside 7d/30d
    wakeEntry(4, NOW - 26 * H, "t2", {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      model: "deepseek-chat",
      billingMode: "token",
    }),
  ];
  const taskProject = new Map([
    ["t1", "alpha"],
    ["t2", "beta"],
  ]);

  test("aggregates tokens per task, project, and workspace", () => {
    const r = summarizeUsage(entries, taskProject, NOW);
    expect(r.workspace.total).toBe(150 + 300 + 1500 + 15);
    expect(r.workspace.wakes).toBe(4);
    expect(r.workspace.cacheRead).toBe(20);
    const t1 = r.tasks.find((t) => t.taskId === "t1")!;
    expect(t1.total).toBe(450);
    expect(t1.projectId).toBe("alpha");
    const beta = r.byProject.find((p) => p.projectId === "beta")!;
    expect(beta.total).toBe(1515);
  });

  test("subscription tokens are counted but not priced ($ excludes them)", () => {
    const r = summarizeUsage(entries, taskProject, NOW);
    // the 1500 subscription tokens land in unpricedTokens, not costUsd
    expect(r.workspace.unpricedTokens).toBe(1500);
    expect(r.workspace.costUsd).toBeGreaterThan(0); // the deepseek wakes are priced
  });

  test("time windows follow entry timestamps (5h excludes the 26h-old wake)", () => {
    const r = summarizeUsage(entries, taskProject, NOW);
    const w5h = r.windows.find((w) => w.label === "last 5h")!;
    const w7d = r.windows.find((w) => w.label === "last 7d")!;
    expect(w5h.wakes).toBe(3); // the 1h/2h/3h wakes, not the 26h one
    expect(w7d.wakes).toBe(4);
  });

  test("renders without throwing", () => {
    const r = summarizeUsage(entries, taskProject, NOW);
    const out = renderUsage(r);
    expect(out).toContain("Usage");
    expect(out).toContain("Windows:");
  });
});
