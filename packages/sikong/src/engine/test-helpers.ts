import {
  emptyUsage,
  type AgentLoop,
  type Capability,
  type CapabilityList,
  type LoopEvent,
  type RunHandle,
  type RunInput,
} from "agent-loop";
import { WorkflowEngine, type LoopFactory } from "./engine";
import { MemoryEventStore, MemoryProjectionStore, MemoryWorkflowRegistry } from "../store/memory";
import { GENERAL_WORKFLOW } from "../workflow/builtin";
import type { WorkflowDef } from "../workflow/types";

export function newEngine(loop: LoopFactory, extra: WorkflowDef[] = [], hooks = {}): WorkflowEngine {
  const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
  for (const wf of extra) registry.register(wf);
  return new WorkflowEngine({
    events: new MemoryEventStore(() => 1),
    projections: new MemoryProjectionStore(),
    registry,
    loop,
    hooks,
  });
}

export async function leadAccept(
  engine: WorkflowEngine,
  taskId: string,
  reason = "lead reviewed evidence",
): Promise<void> {
  await engine.submitCommand(
    taskId,
    { kind: "acceptance_decision", decision: "accepted", reason },
    "lead",
  );
  await engine.idle();
}

export const SIMPLE_COMMIT: WorkflowDef = {
  id: "simple-commit",
  version: "1",
  name: "Simple Commit",
  description: "single-stage workflow used to test worker work-log review behavior",
  fields: {
    summary: { type: "string", description: "result summary" },
  },
  stages: [
    {
      id: "work",
      category: "in_progress",
      entry: { op: "always" },
      outputFields: ["summary"],
    },
    {
      id: "done",
      category: "done",
      entry: { op: "hasEvent", eventType: "transition.requested" },
    },
  ],
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function eventRunHandle(events: LoopEvent[]): RunHandle {
  const result = Promise.resolve({
    events,
    usage: emptyUsage(),
    durationMs: 0,
    status: "completed" as const,
    text: "",
  });
  const iter = async function* (): AsyncGenerator<LoopEvent> {
    for (const event of events) yield event;
  };
  const none = async function* (): AsyncGenerator<never> {};
  return {
    [Symbol.asyncIterator]: () => iter(),
    textStream: none(),
    result,
    text: result.then((r) => r.text),
    usage: result.then((r) => r.usage),
    steer: async () => ({ mode: "rejected" as const }),
    cancel: () => {},
    cleanup: async () => ({
      status: "settled" as const,
      elapsedMs: 0,
      hardKill: false,
      resultStatus: (await result).status,
    }),
  };
}

/** A loop whose run() executes `body` (which may await), resolving when it finishes. */
export function scriptLoop(body: (input: RunInput) => Promise<string | void>, id = "scripted"): AgentLoop {
  const capabilities: CapabilityList = ["tools"];
  return {
    id,
    capabilities,
    supports: (c: Capability) => capabilities.includes(c),
    run(input: RunInput): RunHandle {
      // Mirror the real RunHandle contract: result NEVER rejects.
      const result = Promise.resolve()
        .then(() => body(input))
        .then(
          (text) => ({
            events: [] as LoopEvent[],
            usage: emptyUsage(),
            durationMs: 0,
            status: "completed" as const,
            text: text ?? "",
          }),
          (err: unknown) => ({
            events: [] as LoopEvent[],
            usage: emptyUsage(),
            durationMs: 0,
            status: "error" as const,
            error: err instanceof Error ? err : new Error(String(err)),
            text: "",
          }),
        );
      const none = async function* (): AsyncGenerator<never> {};
      return {
        [Symbol.asyncIterator]: () => none(),
        textStream: none(),
        result,
        text: result.then((r) => r.text),
        usage: result.then((r) => r.usage),
        steer: async () => ({ mode: "rejected" as const }),
        cancel: () => {},
        cleanup: async () => ({
          status: "settled" as const,
          elapsedMs: 0,
          hardKill: false,
          resultStatus: (await result).status,
        }),
      };
    },
    preflight: async () => ({ ok: true }),
    dispose: async () => {},
  };
}

/** A script loop that lets tests observe whether the engine cancelled the run. */
export function cancellableScriptLoop(
  body: (input: RunInput, isCancelled: () => boolean) => Promise<string | void>,
  id = "scripted-cancellable",
): AgentLoop {
  const capabilities: CapabilityList = ["tools"];
  return {
    id,
    capabilities,
    supports: (c: Capability) => capabilities.includes(c),
    run(input: RunInput): RunHandle {
      let cancelled = false;
      const work = body(input, () => cancelled);
      const result = work.then((text) => ({
        events: [] as LoopEvent[],
        usage: emptyUsage(),
        durationMs: 0,
        status: cancelled ? ("cancelled" as const) : ("completed" as const),
        text: text ?? "",
      }));
      const none = async function* (): AsyncGenerator<never> {};
      return {
        [Symbol.asyncIterator]: () => none(),
        textStream: none(),
        result,
        text: result.then((r) => r.text),
        usage: result.then((r) => r.usage),
        steer: async () => ({ mode: "rejected" as const }),
        cancel: () => {
          cancelled = true;
        },
        cleanup: async (options) => {
          cancelled = true;
          const graceMs = Math.max(0, options?.graceMs ?? 0);
          const settled = await Promise.race([
            result,
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), graceMs)),
          ]);
          return settled
            ? {
                status: "cancelled_settled" as const,
                elapsedMs: 0,
                hardKill: options?.hardKill ?? false,
                resultStatus: settled.status,
                ...(options?.reason ? { reason: options.reason } : {}),
              }
            : {
                status: "unsettled" as const,
                elapsedMs: graceMs,
                hardKill: options?.hardKill ?? false,
                ...(options?.reason ? { reason: options.reason } : {}),
              };
        },
      };
    },
    preflight: async () => ({ ok: true }),
    dispose: async () => {},
  };
}

/** A backend that never returns and ignores cancellation — simulates a wedged run. */
export function hangingLoop(): AgentLoop {
  const capabilities: CapabilityList = ["tools"];
  const never = new Promise<never>(() => {});
  const none = async function* (): AsyncGenerator<never> {};
  return {
    id: "hang",
    capabilities,
    supports: (c: Capability) => capabilities.includes(c),
    run(): RunHandle {
      return {
        [Symbol.asyncIterator]: () => none(),
        textStream: none(),
        result: never,
        text: never,
        usage: never,
        steer: async () => ({ mode: "rejected" as const }),
        cancel: () => {},
        cleanup: async (options) => ({
          status: "unsettled" as const,
          elapsedMs: Math.max(0, options?.graceMs ?? 0),
          hardKill: options?.hardKill ?? false,
          ...(options?.reason ? { reason: options.reason } : {}),
          pidUnavailableReason: "test backend ignores cancellation",
        }),
      };
    },
    preflight: async () => ({ ok: true }),
    dispose: async () => {},
  };
}

/** A backend whose cleanup method itself never returns — simulates a broken adapter cleanup. */
export function cleanupHangingLoop(): AgentLoop {
  const capabilities: CapabilityList = ["tools"];
  const never = new Promise<never>(() => {});
  const none = async function* (): AsyncGenerator<never> {};
  return {
    id: "cleanup-hang",
    capabilities,
    supports: (c: Capability) => capabilities.includes(c),
    run(): RunHandle {
      return {
        [Symbol.asyncIterator]: () => none(),
        textStream: none(),
        result: never,
        text: never,
        usage: never,
        steer: async () => ({ mode: "rejected" as const }),
        cancel: () => {},
        cleanup: async () => never,
      };
    },
    preflight: async () => ({ ok: true }),
    dispose: async () => {},
  };
}
