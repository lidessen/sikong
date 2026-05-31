import type { BackendAdapter } from "../adapter/adapter";
import { AgentLoopError } from "../core/errors";
import type { BackendId } from "../core/types";
import { MockAdapter, type MockAdapterOptions } from "./mock";

/**
 * Lazily resolve a backend adapter by id.
 *
 * Only `mock` is built in here. The real backends (`claude`, `codex`, `cursor`,
 * `ai-sdk`) pull heavy SDK dependencies, so import their adapter classes
 * directly (`agent-loop/adapters/claude`) and pass the instance to
 * `createExecutor` — keeping the core import dependency-free.
 */
export function createAdapter(id: BackendId, opts?: unknown): BackendAdapter {
  switch (id) {
    case "mock":
      return new MockAdapter(opts as MockAdapterOptions | undefined);
    default:
      throw new AgentLoopError(
        `No built-in factory for backend "${id}". Import its adapter directly, ` +
          `e.g. \`import { ClaudeAdapter } from "agent-loop/adapters/claude"\`, ` +
          `then \`createExecutor(new ClaudeAdapter(opts))\`.`,
      );
  }
}
