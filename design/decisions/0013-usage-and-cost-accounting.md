# 0013 — Usage & cost accounting (tokens, cache, $; subscription windows)

Status: Accepted
Date: 2026-06-03

## Context

sikong drove a real multi-project dogfood (chiling + shilu) with paid LLM
workers and had **no usage or cost visibility**: agent-loop returned
`RunResult.usage` per run but sikong discarded it. The owner: "准确的usage统计和
费用估计是必要的." Two refinements followed: cache hits must be counted apart
(cache-read is ~10× cheaper than fresh input, so lumping them mis-costs), and
pricing should come from the provider, not be hand-maintained. Prior art exists
and was adopted rather than reinvented: **ccusage** (parses Claude Code logs into
per-model token + cost + 5-hour-window blocks) and **LiteLLM's
`model_prices_and_context_window.json`** (the community-maintained price map).

A subtlety the dogfood exposed: pay-per-token (API key) and subscription
(Claude OAuth / codex login) are different billing axes. Subscription cost is not
dollars but rolling-window quota (Anthropic's 5-hour + weekly unified limits).

## Decision

Separate **what was consumed** (tokens — always captured) from **what it costs**
(mode-dependent), across three layers:

1. **agent-loop — usage shape + cache (accurate tokens).** The normalized
   `usage` event and `TokenUsage` carry optional `cacheReadTokens` /
   `cacheCreationTokens`; `inputTokens` means *uncached* input consistently. Each
   adapter maps native cache fields (claude: `cache_read/creation_input_tokens`;
   ai-sdk: `cachedInputTokens` subtracted out of input; cursor: none → absent).
   **Cancellation must not lose usage:** sikong stops a worker run the instant a
   terminal tool call is recorded, so the backend's final usage often never
   arrives. The claude adapter now captures per-turn usage from assistant
   messages (the `result` message stays authoritative); the ai-sdk adapter
   resolves with accumulated step usage on abort instead of rejecting. (Known
   minor gap: an ai-sdk run cancelled mid-final-step can undercount that step's
   output tokens; claude is unaffected because the assistant message is complete
   before the cancel.)

2. **agent-loop — pricing from the provider, sourced from LiteLLM.** `ModelProvider`
   gains optional `pricing(modelId): ModelPricing | undefined`. Prices are NOT
   hand-maintained: `scripts/refresh-prices.ts` fetches LiteLLM's map, filters to
   the providers we ship, converts per-token → per-1M, and writes
   `src/providers/prices.generated.ts`. Lookup is exact-then-longest-prefix (so
   `claude-sonnet-4-6` maps to the closest `claude-sonnet-4-5`); an unknown model
   returns undefined → cost n/a, never guessed. Exported standalone as
   `modelPricing()` so consumers can price without constructing a credentialed
   provider.

3. **sikong — capture, aggregate, report.** The engine records each wake's usage
   (summed over worker + commit passes) plus the hired model/provider/billingMode
   on its `wake.end`/`wake.error` chronicle entry (via an injected
   `describeWorker` resolver — the engine stays provider-agnostic). `sikong usage
   [--project] [--text]` aggregates per task / project / workspace, prices
   token-billed wakes via `modelPricing`, and shows ccusage-style 5h / 7d / 30d
   windows.

### Billing modes (honesty)

- `token` (API key): tokens **and** $ cost.
- `subscription` (OAuth/login): tokens and time-windowed absolute usage; **$ is
  n/a** (never fabricated). Unknown model price → also n/a.

## Alternatives considered

- **Hand-maintained price tables** (the first cut): rejected — prices drift and
  it duplicates LiteLLM's maintained map. Replaced with the vendored snapshot +
  refresh script.
- **Compute cost in the engine**: rejected — keeps provider/pricing knowledge out
  of the task-agnostic engine; the engine only records opaque tokens + worker
  descriptor, the report layer prices.
- **Shell out to ccusage** for Claude subscription usage: rejected as the primary
  path — sikong needs unified cross-runtime accounting in its own chronicle. We
  borrow ccusage's 5h-block *algorithm* instead of depending on the CLI.

## Deferred

**Subscription rate-limit % (5h/weekly utilization).** Anthropic exposes it via
`anthropic-ratelimit-unified-5h-utilization` / `-7d-utilization` headers, but the
Claude Code SDK does not surface response headers yet (open upstream issues). So
v1 reports absolute windowed usage, not %. Revisit when the SDK exposes the
headers (or on a direct-API path).

## Consequences

- Accurate token + cost visibility for pay-per-token workers; honest tokens-only
  for subscription/unknown. Stays task-agnostic (usage is generic observability),
  consistent with ADR 0007.
- New durable surface: `wake.*` chronicle entries now carry a `usage` object;
  `sikong usage` command; vendored price snapshot with a refresh script.
