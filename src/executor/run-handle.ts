import type {
  AdapterHookBridge,
  BackendAdapter,
  BackendResult,
  BackendRun,
} from "../adapter/adapter";
import { hasCapability, type CapabilityList } from "../core/capabilities";
import { createEventChannel } from "../core/channel";
import { addUsage, emptyUsage, type LoopEvent, type TokenUsage } from "../core/events";
import { CapabilityNotSupportedError } from "../core/errors";
import type { HookDecision, Hooks, ToolHookDecision } from "../core/hooks";
import type { BackendId, RunHandle, RunInput, RunResult, SteerOutcome } from "../core/types";
import { compileRequest } from "./skills";

/**
 * A backend whose adapter (and SDK) is constructed lazily on first run. The
 * capabilities are known up front so gating happens synchronously without
 * loading anything.
 */
export interface LazyBackend {
  id: BackendId;
  capabilities: CapabilityList;
  getAdapter(): Promise<BackendAdapter>;
}

/**
 * Wire a (lazily-loaded) backend to the unified hook bus + steer routing and
 * return a `RunHandle`. The heart of the executor: skill compilation, sync
 * capability gating, hook dispatch off the event stream, steer routing, and
 * result aggregation all live here — backend-agnostic.
 */
export function startRun(backend: LazyBackend, input: RunInput): RunHandle {
  const caps = backend.capabilities;
  const hooks: Hooks = input.hooks ?? {};
  const { system, tools, mcp } = compileRequest(input);

  // Honest capability gating — synchronous, before any adapter/SDK loads.
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

  let backendRun: BackendRun | null = null;
  let cancelledBeforeStart = false;
  let wasCancelled = false;
  let cancelReason: string | undefined;
  const pendingSteers: string[] = [];

  let resolveResult!: (r: RunResult) => void;
  const resultPromise = new Promise<RunResult>((resolve) => {
    resolveResult = resolve;
  });

  const bridge: AdapterHookBridge = {
    async toolUse(ev): Promise<ToolHookDecision> {
      if (!hooks.onToolUse) return { action: "continue" };
      return (await hooks.onToolUse(ev)) ?? { action: "continue" };
    },
  };

  function emitSteer(message: string, mode: "live" | "deferred"): void {
    const ev: LoopEvent = { type: "steer", message, mode };
    collected.push(ev);
    out.push(ev);
  }

  async function doSteer(message: string): Promise<SteerOutcome> {
    if (!backendRun) {
      pendingSteers.push(message); // applied once the run begins
      return { mode: "deferred" };
    }
    if (!backendRun.steer) return { mode: "rejected" };
    const mode = await backendRun.steer(message);
    emitSteer(message, mode);
    return { mode };
  }

  function doCancel(reason?: string): void {
    wasCancelled = true;
    cancelReason = reason;
    if (backendRun) backendRun.cancel(reason);
    else cancelledBeforeStart = true;
  }

  async function applyDecision(decision: HookDecision | void): Promise<void> {
    if (!decision || decision.action === "continue") return;
    if (decision.action === "steer") await doSteer(decision.message);
    else if (decision.action === "stop") doCancel(decision.reason);
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

      const adapter = await backend.getAdapter();
      if (cancelledBeforeStart) {
        finalize("cancelled");
        return;
      }

      backendRun = adapter.start({
        system,
        prompt: input.prompt,
        tools,
        mcp,
        maxSteps: input.maxSteps,
        signal: input.signal,
        backendOptions: input.backendOptions,
        hooks: bridge,
      });

      // Apply steers queued before the adapter was ready.
      for (const message of pendingSteers.splice(0)) {
        if (backendRun.steer) emitSteer(message, await backendRun.steer(message));
      }

      for await (const ev of backendRun) {
        collected.push(ev);
        switch (ev.type) {
          case "text":
            text += ev.text;
            await applyDecision(await hooks.onMessage?.(ev));
            break;
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
          case "usage":
            usage = addUsage(usage, ev);
            await hooks.onUsage?.(ev);
            break;
          case "step":
            if (ev.phase === "end") await applyDecision(await hooks.onStep?.({ index: ev.index }));
            break;
        }
        out.push(ev);
      }

      if (wasCancelled) finalize("cancelled");
      else finalize("completed", await backendRun.result);
    } catch (err) {
      if (wasCancelled) {
        finalize("cancelled");
        return;
      }
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
    cancel: (reason) => doCancel(reason),
  };
}
