/**
 * Normalized events emitted by every backend adapter.
 *
 * The whole point of agent-loop is that a Claude run, a Codex run, a Cursor run
 * and an AI SDK run all surface the *same* event stream. Adapters are
 * responsible for translating their native protocol into this union.
 */
export type LoopEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call_start";
      name: string;
      /** Present on Claude, Cursor, AI SDK. Absent on Codex. */
      callId?: string;
      args?: Record<string, unknown>;
    }
  | {
      /** Not all backends emit this. Do not assume start/end pairs. */
      type: "tool_call_end";
      name: string;
      callId?: string;
      result?: unknown;
      durationMs?: number;
      error?: string;
    }
  | {
      type: "usage";
      /** Uncached input tokens (excludes cache read/creation). */
      inputTokens: number;
      outputTokens: number;
      /** Context-pressure tokens, excluding cache-read cost. */
      activeTokens?: number;
      totalTokens: number;
      /** Cache-read input tokens (cheap hits), if the backend reports them. */
      cacheReadTokens?: number;
      /** Cache-creation/write input tokens, if the backend reports them. */
      cacheCreationTokens?: number;
      /** Model context window limit, if the backend reports it. */
      contextWindow?: number;
      /** totalTokens / contextWindow when contextWindow is known. */
      usedRatio?: number;
      /** "runtime" = reported by the provider; "estimate" = computed locally. */
      source: "runtime" | "estimate";
    }
  | { type: "step"; phase: "start" | "end"; index: number }
  | {
      /** A steer message was injected into this run (by a hook or the caller). */
      type: "steer";
      message: string;
      mode: "live" | "deferred";
    }
  | {
      /** Backend-native hook lifecycle (currently only Claude surfaces these). */
      type: "hook";
      phase: "started" | "progress" | "response";
      name: string;
      hookEvent: string;
      output?: string;
      stdout?: string;
      stderr?: string;
      outcome?: "success" | "error" | "cancelled";
    }
  | { type: "error"; error: Error }
  | { type: "unknown"; data: unknown };

/** Aggregate token usage for a completed run. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Tokens that approximate current context pressure: uncached input + output
   * + cache-creation tokens. Cache-read tokens are tracked separately because
   * runtimes may report them cumulatively across snapshots.
   */
  activeTokens?: number;
  totalTokens: number;
  /** Cache-read input tokens (cheap hits), if any backend reported them. */
  cacheReadTokens?: number;
  /** Cache-creation/write input tokens, if any backend reported them. */
  cacheCreationTokens?: number;
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

/** Fold a `usage` event into a running total. Cache fields stay absent unless a backend reported them. */
export function addUsage(
  acc: TokenUsage,
  ev: {
    inputTokens: number;
    outputTokens: number;
    activeTokens?: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
): TokenUsage {
  const hasCache =
    acc.cacheReadTokens !== undefined ||
    acc.cacheCreationTokens !== undefined ||
    ev.cacheReadTokens !== undefined ||
    ev.cacheCreationTokens !== undefined;
  return {
    inputTokens: acc.inputTokens + ev.inputTokens,
    outputTokens: acc.outputTokens + ev.outputTokens,
    activeTokens: activeUsageTokens(acc) + activeUsageTokens(ev),
    totalTokens: acc.totalTokens + ev.totalTokens,
    ...(hasCache
      ? {
          cacheReadTokens: (acc.cacheReadTokens ?? 0) + (ev.cacheReadTokens ?? 0),
          cacheCreationTokens: (acc.cacheCreationTokens ?? 0) + (ev.cacheCreationTokens ?? 0),
        }
      : {}),
  };
}

export function activeUsageTokens(usage: {
  inputTokens: number;
  outputTokens: number;
  activeTokens?: number;
  cacheCreationTokens?: number;
}): number {
  return (
    usage.activeTokens ?? usage.inputTokens + usage.outputTokens + (usage.cacheCreationTokens ?? 0)
  );
}

/** Rough char-based token estimate for backends that do not report usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
