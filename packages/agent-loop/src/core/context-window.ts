/**
 * Context-window sizing for the `usage` event's `contextWindow` / `usedRatio`
 * fields — the signal the outer task supervisor (ralph loop) uses to decide when
 * a run is about to run out of room and should hand off.
 *
 * Honesty over guessing: the table holds well-known model windows matched by
 * substring; an unknown model resolves to `undefined`, leaving `usedRatio`
 * unset rather than fabricated. Each adapter also accepts an explicit
 * `contextWindow` override (the reliable path) which always wins.
 *
 * Values are approximate and overridable — they only need to be close enough
 * for a fractional threshold (e.g. "0.8 full"), not exact.
 */

interface WindowRule {
  /** Lowercased substring matched against the model id. */
  match: string;
  tokens: number;
}

// Order matters: more specific substrings first.
const KNOWN_WINDOWS: WindowRule[] = [
  // Anthropic Claude 4.x family
  { match: "claude-opus", tokens: 200_000 },
  { match: "claude-sonnet", tokens: 200_000 },
  { match: "claude-haiku", tokens: 200_000 },
  { match: "claude", tokens: 200_000 },
  // OpenAI
  { match: "gpt-4.1", tokens: 1_000_000 },
  { match: "gpt-5", tokens: 400_000 },
  { match: "gpt-4o", tokens: 128_000 },
  { match: "o3", tokens: 200_000 },
  { match: "o1", tokens: 200_000 },
  // DeepSeek (v3.1+/v4)
  { match: "deepseek", tokens: 128_000 },
  // Google Gemini
  { match: "gemini-2", tokens: 1_000_000 },
  { match: "gemini", tokens: 1_000_000 },
];

/**
 * Resolve a model's context window. Explicit `override` wins; otherwise look up
 * the known table by substring; otherwise `undefined` (unknown — don't guess).
 */
export function resolveContextWindow(
  modelId: string | undefined,
  override: number | undefined,
): number | undefined {
  if (override && override > 0) return override;
  if (!modelId) return undefined;
  const id = modelId.toLowerCase();
  for (const rule of KNOWN_WINDOWS) {
    if (id.includes(rule.match)) return rule.tokens;
  }
  return undefined;
}

/**
 * Build the optional `contextWindow` / `usedRatio` fields for a `usage` event.
 * Returns an empty object when the window is unknown, so spreading it is a no-op:
 *
 *   ch.push({ type: "usage", inputTokens, outputTokens, totalTokens, source,
 *             ...contextFields(totalTokens, ctx) });
 */
export function contextFields(
  totalTokens: number,
  contextWindow: number | undefined,
): { contextWindow?: number; usedRatio?: number } {
  if (!contextWindow || contextWindow <= 0) return {};
  return { contextWindow, usedRatio: totalTokens / contextWindow };
}
