import type { BackendAdapter } from "../adapter/adapter";
import type { CapabilityList } from "../core/capabilities";
import type { BackendId, PreflightResult, RunHandle, RunInput } from "../core/types";
import { startRun } from "./run-handle";

/**
 * The unified entry point. Wraps a single backend adapter and exposes one
 * method that matters: `run(input)` — one call, one full agent loop.
 */
export class Executor {
  constructor(private readonly backend: BackendAdapter) {}

  get id(): BackendId {
    return this.backend.id;
  }

  get capabilities(): CapabilityList {
    return this.backend.capabilities;
  }

  /** Start one loop. Returns immediately with a streaming handle. */
  run(input: RunInput | string): RunHandle {
    const normalized: RunInput =
      typeof input === "string" ? { prompt: input } : input;
    return startRun(this.backend, normalized);
  }

  preflight(): Promise<PreflightResult> {
    return this.backend.preflight?.() ?? Promise.resolve({ ok: true });
  }

  dispose(): Promise<void> {
    return this.backend.dispose?.() ?? Promise.resolve();
  }
}
