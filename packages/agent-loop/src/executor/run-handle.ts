import type { AdapterHookBridge, BackendAdapter, BackendResult, BackendRun } from "../core/adapter";
import { hasCapability, type CapabilityList } from "../core/capabilities";
import { createEventChannel } from "../core/channel";
import { addUsage, emptyUsage, type LoopEvent, type TokenUsage } from "../core/events";
import { CapabilityNotSupportedError } from "../core/errors";
import type { HookDecision, Hooks, ToolHookDecision } from "../core/hooks";
import type {
  CleanupOptions,
  CleanupResult,
  RuntimeId,
  RunHandle,
  RunInput,
  RunResult,
  SteerOutcome,
} from "../core/types";
import { compileRequest } from "./skills";

/**
 * A backend whose adapter (and SDK) is constructed lazily on first run. The
 * capabilities are known up front so gating happens synchronously without
 * loading anything.
 */
export interface LazyBackend {
  id: RuntimeId;
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

  // ---- Replay broadcast --------------------------------------------------
  // Every emitted event is recorded in `collected` and fanned out to all live
  // subscribers. A new subscriber replays everything so far, then goes live —
  // so the events / textStream can each be consumed independently, any number
  // of times, even after the run has finished. Iteration never throws: errors
  // surface as an `error` event plus `result.status === "error"`.
  const collected: LoopEvent[] = [];
  const subscribers = new Set<ReturnType<typeof createEventChannel<LoopEvent>>>();
  let streamDone = false;

  function publish(ev: LoopEvent): void {
    collected.push(ev);
    for (const s of subscribers) s.push(ev);
  }
  function endStream(): void {
    streamDone = true;
    for (const s of subscribers) s.end();
  }
  function subscribe(): AsyncIterable<LoopEvent> {
    const ch = createEventChannel<LoopEvent>();
    for (const ev of collected) ch.push(ev);
    if (streamDone) ch.end();
    else subscribers.add(ch);
    return ch.iterable;
  }

  let usage: TokenUsage = emptyUsage();
  let text = "";
  let settled = false;
  const startedAt = Date.now();

  let backendRun: BackendRun | null = null;
  let cancelledBeforeStart = false;
  let wasCancelled = false;
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

  async function doSteer(message: string): Promise<SteerOutcome> {
    if (!backendRun) {
      pendingSteers.push(message); // applied once the run begins
      return { mode: "deferred" };
    }
    if (!backendRun.steer) return { mode: "rejected" };
    const mode = await backendRun.steer(message);
    publish({ type: "steer", message, mode });
    return { mode };
  }

  function doCancel(reason?: string): void {
    wasCancelled = true;
    if (backendRun) {
      void backendRun.result.catch(() => {});
      backendRun.cancel(reason);
    } else {
      cancelledBeforeStart = true;
    }
  }

  async function waitForResult(graceMs: number | undefined): Promise<RunResult | undefined> {
    if (settled) return resultPromise;
    const ms = Math.max(0, graceMs ?? 0);
    if (ms === 0) return undefined;
    return Promise.race([
      resultPromise,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
    ]);
  }

  async function doCleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
    const started = Date.now();
    const hardKill = options.hardKill ?? false;
    const base = {
      hardKill,
      ...(options.reason ? { reason: options.reason } : {}),
      runtime: backend.id,
    };

    if (settled) {
      const result = await resultPromise;
      return {
        ...base,
        status: result.status === "cancelled" ? "cancelled_settled" : "settled",
        elapsedMs: Date.now() - started,
        resultStatus: result.status,
      };
    }

    if (backendRun?.cleanup) {
      try {
        const cleanup = await backendRun.cleanup(options);
        return {
          ...base,
          ...cleanup,
          runtime: cleanup.runtime ?? backend.id,
          hardKill: cleanup.hardKill ?? hardKill,
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        return {
          ...base,
          status: "unsettled",
          elapsedMs: Date.now() - started,
          error: error.message,
        };
      }
    }

    doCancel(options.reason);
    const result = await waitForResult(options.graceMs);
    if (result) {
      return {
        ...base,
        status: result.status === "cancelled" ? "cancelled_settled" : "settled",
        elapsedMs: Date.now() - started,
        resultStatus: result.status,
      };
    }
    return {
      ...base,
      status: "unsettled",
      elapsedMs: Date.now() - started,
      pidUnavailableReason: "adapter did not expose a process id",
    };
  }

  async function applyDecision(decision: HookDecision | void): Promise<void> {
    if (!decision || decision.action === "continue") return;
    if (decision.action === "steer") await doSteer(decision.message);
    else if (decision.action === "stop") doCancel(decision.reason);
  }

  async function finalize(
    status: RunResult["status"],
    backendResult?: BackendResult,
    error?: Error,
  ): Promise<void> {
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
    try {
      await hooks.onEnd?.(result);
    } catch {
      // Observational hook — a throw must not crash the run.
    }
    endStream();
    resolveResult(result);
  }

  async function pump(): Promise<void> {
    try {
      await hooks.onStart?.({ runtime: backend.id, system, prompt: input.prompt });

      const adapter = await backend.getAdapter();
      if (cancelledBeforeStart) {
        await finalize("cancelled");
        return;
      }

      backendRun = adapter.start({
        system,
        prompt: input.prompt,
        tools,
        mcp,
        maxSteps: input.maxSteps,
        signal: input.signal,
        effort: input.effort,
        runtimeOptions: input.runtimeOptions,
        metadata: input.metadata,
        hooks: bridge,
      });

      // Apply steers queued before the adapter was ready.
      for (const message of pendingSteers.splice(0)) {
        if (backendRun.steer)
          publish({ type: "steer", message, mode: await backendRun.steer(message) });
      }

      for await (const rawEv of backendRun) {
        let ev = rawEv;
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
          case "usage": {
            // Fill contextWindow/usedRatio from the backend's declared window
            // when the adapter didn't already (central, DRY).
            const ctx = backendRun.contextWindow;
            if (ctx && ev.usedRatio === undefined) {
              ev = { ...ev, contextWindow: ctx, usedRatio: ev.totalTokens / ctx };
            }
            usage = addUsage(usage, ev);
            await hooks.onUsage?.(ev);
            break;
          }
          case "step":
            if (ev.phase === "end") await applyDecision(await hooks.onStep?.({ index: ev.index }));
            break;
        }
        publish(ev);
      }

      // Even on cancel, prefer the backend's final usage: it estimates output
      // tokens that some runtimes (DeepSeek) report only in a `result` message
      // the cancel skips. Falling back to the event-accumulated usage would lose
      // them (output would read 0). See fillEstimatedOutput in adapters/claude.ts.
      if (wasCancelled) await finalize("cancelled", await backendRun.result.catch(() => undefined));
      else await finalize("completed", await backendRun.result);
    } catch (err) {
      if (wasCancelled) {
        const cancelledResult = backendRun
          ? await backendRun.result.catch(() => undefined)
          : undefined;
        await finalize("cancelled", cancelledResult);
        return;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      publish({ type: "error", error });
      await finalize("error", undefined, error);
    }
  }

  void pump();

  return {
    [Symbol.asyncIterator]: () => subscribe()[Symbol.asyncIterator](),
    get textStream(): AsyncIterable<string> {
      const events = subscribe();
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<string> {
          for await (const ev of events) {
            if (ev.type === "text") yield ev.text;
          }
        },
      };
    },
    result: resultPromise,
    text: resultPromise.then((r) => r.text),
    usage: resultPromise.then((r) => r.usage),
    steer: (message) => doSteer(message),
    cancel: (reason) => doCancel(reason),
    cleanup: (options) => doCleanup(options),
  };
}
