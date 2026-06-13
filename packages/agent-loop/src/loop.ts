import type { BackendAdapter } from "./core/adapter";
import { hasCapability, type Capability, type CapabilityList } from "./core/capabilities";
import type { RuntimeId, PreflightResult, RunHandle, RunInput } from "./core/types";
import { startRun, type LazyBackend } from "./executor/run-handle";
import { runTask, type TaskInput, type TaskResult } from "./task/run-task";

export type AgentLoopTaskInput = Omit<TaskInput, "loop">;

/**
 * The unified handle every backend factory returns. One call = one full loop:
 * `loop.run(input)` streams normalized events and resolves a `RunResult`.
 *
 * The interface is identical across `aiSdkLoop` / `claudeCodeLoop` / `codexLoop`
 * / `cursorLoop` / `mockLoop` — the backend is the only thing that differs.
 */
export interface AgentLoop {
  readonly id: RuntimeId;
  readonly capabilities: CapabilityList;
  /** True if this loop's runtime supports `cap` (e.g. `loop.supports("tools")`). */
  supports(cap: Capability): boolean;
  /** Start one loop. Returns immediately with a streaming handle. */
  run(input: RunInput | string): RunHandle;
  /** Run a multi-round task using this loop as the worker loop. */
  runTask(input: AgentLoopTaskInput): Promise<TaskResult>;
  /** Check the backend's CLI / SDK / credentials availability. */
  preflight(): Promise<PreflightResult>;
  /** Release any long-lived resources (subprocesses, SDK clients, ...). */
  dispose(): Promise<void>;
}

/**
 * Wrap a lazily-loaded backend adapter as an `AgentLoop`.
 *
 * The adapter module (and its heavy SDK) is imported on first use, so importing
 * a factory never drags in the other backends' dependencies. Capabilities are
 * known up front (passed in) so gating + `loop.capabilities` work without
 * loading anything.
 */
export function makeLoop(
  id: RuntimeId,
  capabilities: CapabilityList,
  load: () => Promise<BackendAdapter>,
): AgentLoop {
  let adapterPromise: Promise<BackendAdapter> | null = null;
  let adapter: BackendAdapter | null = null;

  const getAdapter = (): Promise<BackendAdapter> => {
    if (!adapterPromise) {
      adapterPromise = load().then((a) => {
        adapter = a;
        return a;
      });
    }
    return adapterPromise;
  };

  const backend: LazyBackend = { id, capabilities, getAdapter };

  const loop: AgentLoop = {
    id,
    capabilities,
    supports(cap) {
      return hasCapability(capabilities, cap);
    },
    run(input) {
      return startRun(backend, typeof input === "string" ? { prompt: input } : input);
    },
    runTask(input) {
      return runTask({
        ...input,
        loop: () => loop,
        disposeRoundLoops: false,
      } as TaskInput & { disposeRoundLoops: false });
    },
    async preflight() {
      const a = await getAdapter();
      return a.preflight?.() ?? { ok: true };
    },
    async dispose() {
      if (adapter) await adapter.dispose?.();
    },
  };
  return loop;
}
