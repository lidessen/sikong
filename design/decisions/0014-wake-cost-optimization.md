# 0014 — Wake cost optimization (flash@max, prefix-stable wakes, pro-on-escalation)

Status: Accepted
Date: 2026-06-03

## Context

A dogfood round (chiling M3 + shilu round-2) cost ~$14.55 / 311M tokens. The
`sikong usage` dashboard located the waste: **lead tasks alone burned ~45M
tokens** because each child completion re-wakes the lead, which re-reads its full
context fresh → DeepSeek's prefix cache (cache-read is ~10× cheaper) never hits.
Some lead re-wakes also ran >20 min (one hit the 1200s wake timeout). Two
researches informed the fix:
- DeepSeek officially recommends **Claude Code** as its agent runtime, with a
  model mapping (deepseek-v4-pro main / deepseek-v4-flash subagent) + max effort.
- **deepseek-reasonix** is built around DeepSeek's prefix cache for cheap long
  sessions; public evals show **flash@max ≈ pro@high on reasoning and within
  1–2 pts on coding**, with pro only meaningfully ahead on long-horizon agentic
  work (7–11 pts) — which sikong's decompose-and-delegate architecture mostly
  avoids.

## Decision

Three changes, no new heavy mechanism:

1. **flash@max as the universal worker; pro only on escalation.** The deepseek
   provider's claude-code config now sets `ANTHROPIC_AUTH_TOKEN`,
   `CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash`, and
   `CLAUDE_CODE_EFFORT_LEVEL=max` (max effort closes most of the flash↔pro gap).
   Pro is NOT pre-assigned to any role/stage.

2. **Prefix-stable wakes.** The wake `system` prompt is now the STABLE half (role,
   stage instructions, project memory, field *schema*, tool lists) — byte-stable
   across a task's re-wakes, so DeepSeek's server-side prefix cache covers it. The
   VOLATILE half (current field *values* + the team snapshot) moved into the
   per-wake message (`buildPrompt`), and the agent is told to pull deeper detail
   (subtask output, files) on demand with its own tools rather than have it all
   pre-stuffed. Directly attacks the lead-re-wake cost.

3. **Pro on escalation (stuck-aware).** `WakeContext.modelTier` is "fast" by
   default and "strong" once a task has a prior failed wake (the circuit breaker's
   error count). The worker boundary maps strong→`deepseek-v4-pro` for DeepSeek
   (other providers keep their model). So pro is spent exactly where flash
   demonstrably failed — "用在刀刃上" — driven by evidence, not a guess. Usage
   attribution (`describeWorker`) reports the escalated model so cost stays
   honest.

## Alternatives considered

- **Pro main / flash subagent (DeepSeek's default mapping).** Rejected as the
  default: evals show flash@max ≈ pro on the bulk of our (decomposed) work at ~3×
  lower price; pro-main would inflate cost for marginal quality.
- **Pre-assign pro to the lead's design stage.** Rejected: evals show flash@max ≈
  pro@high on *reasoning*, so the design stage gains little; escalation targets
  pro better.
- **Send less context (truncate) on re-wake.** Weaker than prefix-stability — the
  win is cache hits on a stable prefix, not just a smaller prompt.

## Consequences

- Expected: large drop in lead-re-wake cost (stable prefix → cache hits at ~10×
  off) + fewer flash retries (max effort) + pro rescue only when needed. To be
  measured next round against the $14.55 / 311M baseline via `sikong usage`.
- Wake prompt structure changed (system schema-only; values+team in the message)
  — a test that asserted the team appeared in `system` now checks the message.
- Stays task-agnostic: model tier is generic resource allocation (like roles),
  resolved at the worker boundary; the engine only forwards the tier.
