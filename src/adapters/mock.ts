import type {
  BackendAdapter,
  BackendResult,
  BackendRun,
  ResolvedRequest,
} from "../core/adapter";
import type { CapabilityList } from "../core/capabilities";
import { createEventChannel } from "../core/channel";
import { estimateTokens, type LoopEvent } from "../core/events";
import type { PreflightResult } from "../core/types";

export interface MockAdapterOptions {
  /** Canned assistant response. Defaults to echoing the prompt. */
  response?: string;
  /** If set, simulate a tool call routed through the hook bridge. */
  simulateTool?: string;
  toolArgs?: Record<string, unknown>;
  /** Emit thinking text before the response. */
  thinking?: string;
  /** If set, fail the run with this message (drives the error path in tests). */
  failWith?: string;
}

/**
 * A fully in-process backend with no SDK or network. Useful for tests and for
 * exercising the executor's hook / steer / capability machinery deterministically.
 */
export class MockAdapter implements BackendAdapter {
  readonly id = "mock";
  readonly capabilities: CapabilityList = [
    "tools",
    "mcp",
    "hooks",
    "steer.deferred",
    "thinking",
    "usage",
    "interrupt",
  ];

  constructor(private readonly opts: MockAdapterOptions = {}) {}

  start(req: ResolvedRequest): BackendRun {
    const ch = createEventChannel<LoopEvent>();
    const steers: string[] = [];
    let cancelled = false;
    const startedAt = Date.now();

    let resolveResult!: (r: BackendResult) => void;
    const result = new Promise<BackendResult>((r) => {
      resolveResult = r;
    });

    const run = async () => {
      ch.push({ type: "step", phase: "start", index: 0 });

      if (this.opts.failWith) {
        ch.fail(new Error(this.opts.failWith));
        return;
      }

      if (this.opts.thinking) {
        ch.push({ type: "thinking", text: this.opts.thinking });
      }

      if (this.opts.simulateTool) {
        const name = this.opts.simulateTool;
        const decision = await req.hooks.toolUse({
          name,
          callId: "mock-tool-1",
          args: this.opts.toolArgs ?? {},
        });
        if (decision.action === "deny") {
          ch.push({
            type: "tool_call_end",
            name,
            callId: "mock-tool-1",
            error: `denied${decision.reason ? `: ${decision.reason}` : ""}`,
          });
        } else {
          const args =
            decision.action === "replaceArgs"
              ? decision.args
              : (this.opts.toolArgs ?? {});
          ch.push({ type: "tool_call_start", name, callId: "mock-tool-1", args });
          ch.push({
            type: "tool_call_end",
            name,
            callId: "mock-tool-1",
            result: { ok: true },
          });
        }
      }

      const response =
        this.opts.response ??
        (cancelled ? "(cancelled)" : `mock response to: ${req.prompt}`);
      ch.push({ type: "text", text: response });

      const inputTokens = estimateTokens(req.system + req.prompt);
      const outputTokens = estimateTokens(response);
      ch.push({
        type: "usage",
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        source: "estimate",
      });

      ch.push({ type: "step", phase: "end", index: 0 });
      ch.end();
      resolveResult({
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        durationMs: Date.now() - startedAt,
      });
    };

    void run();

    return {
      [Symbol.asyncIterator]: () => ch.iterable[Symbol.asyncIterator](),
      result,
      steer: async (message: string) => {
        steers.push(message);
        return "deferred";
      },
      cancel: () => {
        cancelled = true;
      },
    };
  }

  preflight(): Promise<PreflightResult> {
    return Promise.resolve({ ok: true });
  }
}
