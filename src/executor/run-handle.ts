import type {
  AdapterHookBridge,
  BackendAdapter,
  BackendResult,
} from "../adapter/adapter";
import { hasCapability } from "../core/capabilities";
import { createEventChannel } from "../core/channel";
import { addUsage, emptyUsage, type LoopEvent, type TokenUsage } from "../core/events";
import { CapabilityNotSupportedError } from "../core/errors";
import type { HookDecision, Hooks, ToolHookDecision } from "../core/hooks";
import type { RunHandle, RunInput, RunResult, SteerOutcome } from "../core/types";
import { compileRequest } from "./skills";

/**
 * Wire a backend run to the unified hook bus + steer routing and return a
 * `RunHandle`. This is the heart of the executor: every backend-agnostic
 * behavior (skill compilation, capability gating, hook dispatch off the event
 * stream, steer routing, result aggregation) lives here.
 */
export function startRun(backend: BackendAdapter, input: RunInput): RunHandle {
  const caps = backend.capabilities;
  const hooks: Hooks = input.hooks ?? {};
  const { system, tools, mcp } = compileRequest(input);

  // Honest capability gating: don't pretend.
  if (Object.keys(tools).length > 0 && !hasCapability(caps, "tools")) {
    throw new CapabilityNotSupportedError(backend.id, "tools");
  }
  if (Object.keys(mcp).length > 0 && !hasCapability(caps, "mcp")) {
    throw new CapabilityNotSupportedError(backend.id, "mcp");
  }

  const out = createEventChannel<LoopEvent>();
  const collected: LoopEvent[] = [];
  let usage: TokenUsage = emptyUsage();
  let text = "";
  let settled = false;
  const startedAt = Date.now();

  const bridge: AdapterHookBridge = {
    async toolUse(ev): Promise<ToolHookDecision> {
      if (!hooks.onToolUse) return { action: "continue" };
      return (await hooks.onToolUse(ev)) ?? { action: "continue" };
    },
  };

  const backendRun = backend.start({
    system,
    prompt: input.prompt,
    tools,
    mcp,
    maxSteps: input.maxSteps,
    signal: input.signal,
    backendOptions: input.backendOptions,
    hooks: bridge,
  });

  let resolveResult!: (r: RunResult) => void;
  const resultPromise = new Promise<RunResult>((resolve) => {
    resolveResult = resolve;
  });

  async function doSteer(message: string): Promise<SteerOutcome> {
    if (!backendRun.steer) return { mode: "rejected" };
    const mode = await backendRun.steer(message);
    out.push({ type: "steer", message, mode });
    collected.push({ type: "steer", message, mode });
    return { mode };
  }

  async function applyDecision(decision: HookDecision | void): Promise<void> {
    if (!decision || decision.action === "continue") return;
    if (decision.action === "steer") {
      await doSteer(decision.message);
    } else if (decision.action === "stop") {
      backendRun.cancel(decision.reason);
    }
  }

  function finalize(
    status: RunResult["status"],
    backendResult?: BackendResult,
    error?: Error,
  ): void {
    if (settled) return;
    settled = true;
    const result: RunResult = {
      events: collected,
      usage: backendResult?.usage ?? usage,
      durationMs: backendResult?.durationMs ?? Date.now() - startedAt,
      status,
      error,
      text,
    };
    Promise.resolve(hooks.onEnd?.(result))
      .catch(() => {})
      .finally(() => out.end());
    resolveResult(result);
  }

  async function pump(): Promise<void> {
    try {
      await hooks.onStart?.({ backend: backend.id, system, prompt: input.prompt });
      for await (const ev of backendRun) {
        collected.push(ev);
        switch (ev.type) {
          case "text": {
            text += ev.text;
            await applyDecision(await hooks.onMessage?.(ev));
            break;
          }
          case "thinking":
            await hooks.onThinking?.(ev);
            break;
          case "tool_call_end":
            await hooks.onToolResult?.({
              name: ev.name,
              callId: ev.callId,
              result: ev.result,
              error: ev.error,
              durationMs: ev.durationMs,
            });
            break;
          case "usage": {
            usage = addUsage(usage, ev);
            await hooks.onUsage?.(ev);
            break;
          }
          case "step":
            if (ev.phase === "end") {
              await applyDecision(await hooks.onStep?.({ index: ev.index }));
            }
            break;
        }
        out.push(ev);
      }
      finalize("completed", await backendRun.result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const ev: LoopEvent = { type: "error", error };
      collected.push(ev);
      out.push(ev);
      finalize("error", undefined, error);
    }
  }

  void pump();

  return {
    [Symbol.asyncIterator]: () => out.iterable[Symbol.asyncIterator](),
    result: resultPromise,
    steer: (message) => doSteer(message),
    cancel: (reason) => backendRun.cancel(reason),
  };
}
