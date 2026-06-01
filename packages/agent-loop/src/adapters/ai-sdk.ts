import {
  ToolLoopAgent,
  stepCountIs,
  tool,
  jsonSchema,
  type ToolSet as AiToolSet,
  type LanguageModel,
  type StepResult,
  type ToolChoice,
  type FlexibleSchema,
  type JSONSchema7,
} from "ai";
import type {
  BackendAdapter,
  BackendResult,
  BackendRun,
  ResolvedRequest,
} from "../core/adapter";
import type { CapabilityList } from "../core/capabilities";
import { createEventChannel } from "../core/channel";
import { resolveContextWindow } from "../core/context-window";
import type { LoopEvent } from "../core/events";
import type { AiSdkProviderSpec } from "../core/provider";
import type { PreflightResult, ToolDefinition, ToolSet } from "../core/types";

/** Per-backend escape hatch for the AI SDK adapter. */
export interface AiSdkRuntimeOptions {
  /** Extra/override system instructions appended to `req.system`. */
  instructions?: string;
  /** Override the soft step cap for this run (otherwise `req.maxSteps`). */
  maxSteps?: number;
  /** Override AI SDK tool choice for this run. */
  toolChoice?: ToolChoice<AiToolSet>;
  /** Limit which tools are active for this run. */
  activeTools?: string[];
  /** Provider-specific options passed through to the AI SDK. */
  providerOptions?: Record<string, unknown>;
}

export interface AiSdkAdapterOptions {
  /**
   * A fully-constructed AI SDK `LanguageModel` (escape hatch / advanced use).
   * Provide this OR `spec` (set by a provider). If both are given, `model` wins.
   */
  model?: LanguageModel;
  /**
   * Provider-supplied model description; the adapter builds the `LanguageModel`
   * lazily (so importing a provider factory never pulls the AI SDK). Set by the
   * `aiSdkLoop({ provider })` factory.
   */
  spec?: AiSdkProviderSpec;
  /** Default system instructions, prepended to `req.system`. */
  instructions?: string;
  /** Default soft cap on agent steps; overridable via `req.maxSteps`. */
  maxSteps?: number;
  /**
   * Override the model's context-window size (tokens) for usage.usedRatio.
   * Recommended when passing a raw `model` (no id to infer the window from).
   */
  contextWindow?: number;
}

/**
 * BackendAdapter over the Vercel AI SDK (`ai` v6), driven through a
 * `ToolLoopAgent` + `agent.stream()`.
 *
 * Capabilities wired here:
 *  - "tools":          unified ToolDefinitions -> ai `tool({...})`.
 *  - "hooks":          genuine pre-tool interception by wrapping each tool's
 *                      `execute` and consulting `req.hooks.toolUse` first.
 *  - "thinking":       maps `StepResult.reasoningText` -> thinking events.
 *  - "usage":          per-step usage with `source: "runtime"`.
 *  - "steer.deferred": a queued steer message is injected as an extra system
 *                      note at the next step via `prepareStep`.
 *  - "interrupt":      cancel() aborts the underlying AbortController.
 */
export class AiSdkAdapter implements BackendAdapter {
  readonly id = "ai-sdk";
  readonly capabilities: CapabilityList = [
    "tools",
    "hooks",
    "thinking",
    "usage",
    "steer.deferred",
    "interrupt",
  ];

  constructor(private readonly options: AiSdkAdapterOptions = {}) {}

  start(req: ResolvedRequest): BackendRun {
    const o = (req.runtimeOptions ?? {}) as AiSdkRuntimeOptions;

    // A raw `model` LanguageModel has no inspectable id; infer only from a
    // provider spec's model id, else rely on the explicit override.
    const contextWindow = resolveContextWindow(
      this.options.spec?.model,
      this.options.contextWindow,
    );

    const ch = createEventChannel<LoopEvent>();
    const startedAt = Date.now();

    const ac = new AbortController();
    if (req.signal) {
      if (req.signal.aborted) ac.abort(req.signal.reason);
      else req.signal.addEventListener("abort", () => ac.abort(req.signal?.reason), { once: true });
    }

    // Deferred-steer queue, drained into the next step's system note.
    const pendingSteers: string[] = [];

    const system = [this.options.instructions, req.system, o.instructions]
      .filter((s): s is string => Boolean(s && s.trim()))
      .join("\n\n");

    const stepBudget = o.maxSteps ?? req.maxSteps ?? this.options.maxSteps;
    const tools = this.buildTools(req, ac.signal);

    const prepareStep = async () => {
      if (pendingSteers.length === 0) return {};
      const note = pendingSteers.splice(0).join("\n");
      ch.push({ type: "steer", message: note, mode: "deferred" });
      return {
        system: system
          ? `${system}\n\n[Steering update]\n${note}`
          : `[Steering update]\n${note}`,
      };
    };

    let resolveResult!: (r: BackendResult) => void;
    let rejectResult!: (e: unknown) => void;
    const result = new Promise<BackendResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const cumulative = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let stepIndex = 0;

    const run = async () => {
      try {
        const model = await this.resolveModel();

        const agent = new ToolLoopAgent<never, AiToolSet>({
          model,
          instructions: system || undefined,
          tools,
          ...(o.toolChoice ? { toolChoice: o.toolChoice } : {}),
          ...(o.activeTools ? { activeTools: o.activeTools as Array<keyof AiToolSet> } : {}),
          ...(o.providerOptions ? { providerOptions: o.providerOptions as never } : {}),
          ...(stepBudget ? { stopWhen: stepCountIs(stepBudget) } : {}),
          prepareStep,
        });

        const streamResult = await agent.stream({
          prompt: req.prompt,
          abortSignal: ac.signal,

          onStepFinish: (step: StepResult<AiToolSet>) => {
            ch.push({ type: "step", phase: "start", index: stepIndex });

            const reasoning = step.reasoningText;
            if (reasoning) ch.push({ type: "thinking", text: reasoning });

            for (const toolCall of step.toolCalls) {
              ch.push({
                type: "tool_call_start",
                name: String(toolCall.toolName),
                callId: toolCall.toolCallId,
                args: toToolArgs(toolCall.input),
              });

              const toolResult = step.toolResults.find(
                (r) => r.toolCallId === toolCall.toolCallId,
              );
              if (toolResult) {
                ch.push({
                  type: "tool_call_end",
                  name: String(toolResult.toolName),
                  callId: toolResult.toolCallId,
                  result: toolResult.output,
                });
              }
            }

            const text = step.text;
            if (text) ch.push({ type: "text", text });

            const usage = step.usage;
            if (usage) {
              cumulative.inputTokens += usage.inputTokens ?? 0;
              cumulative.outputTokens += usage.outputTokens ?? 0;
              cumulative.totalTokens = cumulative.inputTokens + cumulative.outputTokens;
              ch.push({
                type: "usage",
                inputTokens: cumulative.inputTokens,
                outputTokens: cumulative.outputTokens,
                totalTokens: cumulative.totalTokens,
                source: "runtime",
              });
            }

            ch.push({ type: "step", phase: "end", index: stepIndex });
            stepIndex += 1;
          },
        });

        // Drain the full stream to drive the agent loop to completion.
        for await (const _ of streamResult.fullStream) {
          // events are surfaced via onStepFinish above
        }

        const total = await streamResult.totalUsage;
        const finalUsage = {
          inputTokens: total.inputTokens ?? cumulative.inputTokens,
          outputTokens: total.outputTokens ?? cumulative.outputTokens,
          totalTokens:
            (total.inputTokens ?? cumulative.inputTokens) +
            (total.outputTokens ?? cumulative.outputTokens),
        };

        ch.end();
        resolveResult({ usage: finalUsage, durationMs: Date.now() - startedAt });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        ch.push({ type: "error", error });
        ch.fail(error);
        rejectResult(error);
      }
    };

    void run();

    return {
      [Symbol.asyncIterator]: () => ch.iterable[Symbol.asyncIterator](),
      result,
      contextWindow,
      steer: async (message: string) => {
        pendingSteers.push(message);
        return "deferred";
      },
      cancel: (reason?: string) => {
        ac.abort(reason);
      },
    };
  }

  /** Resolve the LanguageModel from `options.model` or build it from `options.spec`. */
  private async resolveModel(): Promise<LanguageModel> {
    if (this.options.model) return this.options.model;
    if (this.options.spec) return resolveAiSdkModel(this.options.spec);
    throw new Error(
      "AiSdkAdapter requires a `model` (LanguageModel) or a `provider` (via aiSdkLoop({ provider })).",
    );
  }

  /**
   * Translate unified ToolDefinitions into AI SDK tools, wrapping each `execute`
   * so the caller's pre-tool hook can deny or replace args BEFORE the real tool
   * runs. This is what makes the "hooks" capability genuine.
   */
  private buildTools(req: ResolvedRequest, signal: AbortSignal): AiToolSet {
    const out: AiToolSet = {};
    const unified: ToolSet = req.tools ?? {};
    for (const [name, def] of Object.entries(unified)) {
      out[name] = this.wrapTool(name, def, req, signal);
    }
    return out;
  }

  private wrapTool(name: string, def: ToolDefinition, req: ResolvedRequest, signal: AbortSignal) {
    const inputSchema = toAiInputSchema(def.inputSchema);
    return tool({
      description: def.description,
      inputSchema,
      execute: async (args, ctx) => {
        const callId = ctx?.toolCallId;
        const argObj = toToolArgs(args) ?? {};

        const decision = await req.hooks.toolUse({ name, callId, args: argObj });
        if (decision.action === "deny") {
          return {
            error: `Tool "${name}" denied${decision.reason ? `: ${decision.reason}` : ""}`,
          };
        }
        const finalArgs = decision.action === "replaceArgs" ? decision.args : argObj;
        if (!def.execute) return { error: `Tool "${name}" has no executor` };
        return await def.execute(finalArgs, { signal, callId });
      },
    });
  }

  async preflight(): Promise<PreflightResult> {
    if (!this.options.model && !this.options.spec) {
      return { ok: false, reason: "No AI SDK model or provider was supplied." };
    }
    return { ok: true };
  }
}

/** Build a `LanguageModel` from a provider spec, importing the SDK lazily. */
async function resolveAiSdkModel(spec: AiSdkProviderSpec): Promise<LanguageModel> {
  switch (spec.kind) {
    case "deepseek": {
      const { createDeepSeek } = await import("@ai-sdk/deepseek");
      return createDeepSeek({
        apiKey: spec.apiKey,
        ...(spec.baseURL ? { baseURL: spec.baseURL } : {}),
      })(spec.model);
    }
    case "openai-compatible": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({
        name: spec.name,
        baseURL: spec.baseURL,
        apiKey: spec.apiKey,
        ...(spec.headers ? { headers: spec.headers } : {}),
      })(spec.model);
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({
        apiKey: spec.apiKey,
        ...(spec.baseURL ? { baseURL: spec.baseURL } : {}),
      })(spec.model);
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({
        apiKey: spec.apiKey,
        ...(spec.baseURL ? { baseURL: spec.baseURL } : {}),
      })(spec.model);
    }
    case "gateway": {
      const { createGateway } = await import("@ai-sdk/gateway");
      return createGateway(spec.apiKey ? { apiKey: spec.apiKey } : {})(spec.model);
    }
  }
}

/**
 * Decide whether a unified `inputSchema` is a Zod schema (pass through) or a
 * plain JSON-schema object (wrap with `jsonSchema()`).
 */
function toAiInputSchema(schema: unknown): FlexibleSchema<Record<string, unknown>> {
  if (!schema || typeof schema !== "object") {
    return jsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
  }
  const s = schema as Record<string, unknown>;
  const looksLikeZod =
    "~standard" in s ||
    "_def" in s ||
    typeof (s as { safeParse?: unknown }).safeParse === "function";
  if (looksLikeZod) return schema as FlexibleSchema<Record<string, unknown>>;
  return jsonSchema<Record<string, unknown>>(s as JSONSchema7);
}

function toToolArgs(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}
