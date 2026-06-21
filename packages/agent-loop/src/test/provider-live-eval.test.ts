import { describe, expect, test } from "vitest";
import {
  aiSdkLoop,
  claudeCodeLoop,
  deepseek,
  defineTool,
  kimi,
  type AgentLoop,
  type ModelProvider,
  type RuntimeType,
} from "../index";
import type { LoopEvent } from "../core/events";

type ProviderId = "deepseek" | "kimi";
type ProviderEvalCase = {
  provider: ProviderId;
  runtime: Extract<RuntimeType, "ai-sdk" | "claude-code">;
  apiKeyEnv: string;
};

const DEFAULT_CASES: ProviderEvalCase[] = [
  { provider: "deepseek", runtime: "ai-sdk", apiKeyEnv: "DEEPSEEK_API_KEY" },
  { provider: "deepseek", runtime: "claude-code", apiKeyEnv: "DEEPSEEK_API_KEY" },
  { provider: "kimi", runtime: "claude-code", apiKeyEnv: "KIMI_CODE_API_KEY" },
];

const runLiveProviderEvals = process.env.AGENT_LOOP_RUN_PROVIDER_EVALS === "1";
const selectedCases = parseSelectedCases(process.env.AGENT_LOOP_PROVIDER_EVAL_CASES, DEFAULT_CASES);

describe("provider live eval", () => {
  for (const evalCase of selectedCases) {
    const name = `${evalCase.provider}/${evalCase.runtime}`;
    const hasKey = Boolean(process.env[evalCase.apiKeyEnv]);
    const run = runLiveProviderEvals && hasKey ? test : test.skip;

    run(
      `${name} can complete a terminal tool loop`,
      async () => {
        const loop = createLoop(evalCase);
        const events: LoopEvent[] = [];
        try {
          const run = loop.run({
            system: "You are a provider smoke-test agent. Use only the provided tools.",
            prompt:
              "Call inspect_provider_eval_fixture first. Then finish by calling finish_provider_eval with ok=true and a short summary.",
            tools: {
              inspect_provider_eval_fixture: defineTool({
                description: "Inspect the provider eval fixture.",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
                execute: () => ({
                  provider: evalCase.provider,
                  runtime: evalCase.runtime,
                  requiredTerminalTool: "finish_provider_eval",
                }),
              }),
              finish_provider_eval: defineTool({
                description: "Submit the provider eval result.",
                inputSchema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    summary: { type: "string" },
                  },
                  required: ["ok", "summary"],
                  additionalProperties: false,
                },
                execute: (args, ctx) => {
                  ctx.requestStop?.("provider eval finished");
                  return { terminal: true, received: args };
                },
              }),
            },
            terminalToolSet: ["finish_provider_eval"],
            maxSteps: 4,
            runtimeOptions:
              evalCase.runtime === "claude-code"
                ? {
                    builtinTools: [],
                    disallowedTools: [
                      "Task",
                      "Agent",
                      "Bash",
                      "bash",
                      "Read",
                      "read",
                      "Write",
                      "write",
                      "Edit",
                      "edit",
                      "MultiEdit",
                      "multiedit",
                      "Glob",
                      "glob",
                      "Grep",
                      "grep",
                      "LS",
                      "ls",
                      "WebFetch",
                      "webfetch",
                      "WebSearch",
                      "websearch",
                      "TodoRead",
                      "todoread",
                      "TodoWrite",
                      "todowrite",
                      "EnterPlanMode",
                      "ExitPlanMode",
                    ],
                  }
                : undefined,
          });

          for await (const event of run) events.push(event);
          const result = await run.result;

          const toolStartNames = events
            .filter(
              (event): event is Extract<LoopEvent, { type: "tool_call_start" }> =>
                event.type === "tool_call_start",
            )
            .map((event) => normalizeToolName(event.name));

          expect(result.status).toBe("completed");
          expect(toolStartNames).toContain("inspect_provider_eval_fixture");
          expect(toolStartNames).toContain("finish_provider_eval");
          expect(result.usage.totalTokens).toBeGreaterThan(0);
        } finally {
          await loop.dispose();
        }
      },
      120_000,
    );
  }

  test("documents the live eval gate", () => {
    expect(selectedCases.length).toBeGreaterThan(0);
  });
});

function createLoop(evalCase: ProviderEvalCase): AgentLoop {
  const provider = createProvider(evalCase.provider);
  switch (evalCase.runtime) {
    case "ai-sdk":
      return aiSdkLoop({ provider });
    case "claude-code":
      return claudeCodeLoop({ provider });
  }
}

function createProvider(provider: ProviderId): ModelProvider {
  switch (provider) {
    case "deepseek":
      return deepseek();
    case "kimi":
      return kimi();
  }
}

function parseSelectedCases(
  raw: string | undefined,
  fallback: ProviderEvalCase[],
): ProviderEvalCase[] {
  if (!raw?.trim()) return fallback;
  const selected = new Set(raw.split(",").map((entry) => entry.trim()));
  return fallback.filter((evalCase) => selected.has(`${evalCase.provider}:${evalCase.runtime}`));
}

function normalizeToolName(name: string): string {
  return name.startsWith("mcp__agent_loop_tools__")
    ? name.slice("mcp__agent_loop_tools__".length)
    : name;
}
