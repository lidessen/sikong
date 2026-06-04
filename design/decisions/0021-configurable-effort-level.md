# 0021 — Configurable, lead-decided effort level (general, per-run)

Status: Accepted
Date: 2026-06-04
Relates: 0014 (wake cost optimization), 0015 (verify stage)

## Context

Reasoning effort is currently **hardcoded** — the deepseek provider pins
`CLAUDE_CODE_EFFORT_LEVEL: "max"` (`providers/index.ts:114`). The usage audit
(2026-06-04) showed max-effort reasoning is the dominant driver of output tokens,
cost, and wall-clock latency (the long-tail wakes >300s that caused timeout
failures). max effort is warranted on the hard, divergent work (design/dialectic)
but wasteful on mechanical stages (plan/build/verify). The owner's direction:
make effort a **general, configurable knob** that the **lead decides** per task —
not a fixed global.

Codex already carries an `effort` construction option; claude-code sets it via a
fixed env; ai-sdk/anthropic express it as reasoning/thinking budget. There is no
*generic, per-run, runtime-agnostic* effort control today.

## Decision

Two layers, mirroring runtime ⊥ provider.

### 1. agent-loop: a generic per-run `effort` (runtime-agnostic)

Add a first-class `effort?: EffortLevel` to `RunInput`, where
`EffortLevel = "low" | "medium" | "high" | "max"`. Each adapter maps it to its
runtime, overriding the provider's default for that one run (per-spawn, never
mutating the parent env — ADR invariant #5):
- **claude-code**: set `CLAUDE_CODE_EFFORT_LEVEL` in the per-spawn child env from
  `req.effort` (falls back to the provider default when unset).
- **codex**: map to its existing `effort` (`max`→`high`, since codex has no max).
- **ai-sdk**: map to the provider's reasoning-effort / thinking-budget option
  where supported; ignore where not (honest no-op).
- **cursor**: no-op (native-only).

`effort` is a generic run knob, not a capability gate — adapters that can't honor
it ignore it. Model/effort precedence stays: per-run `effort` wins over the
provider default.

### 2. sikong: the lead decides (configurable, with sensible defaults)

Effort is resolved per wake from, highest-precedence first:
1. **task/subtask override** — the lead sets it when delegating:
   `create_subtask({ ..., effort })`. This is "lead 决定" — the lead reads each
   layer's difficulty and dials effort up for hard pieces, down for rote ones.
2. **stage default** — `StageDef.effort?` in the workflow def (e.g. `design`/
   dialectic → `high`/`max`; `plan`/`build`/`verify` → `medium`). This is the
   "通用配置": effort tracks the *kind* of work by default.
3. **workflow default** → **workspace default** (`medium`) → **provider default**.

The engine resolves the effort for each wake and passes it to `loop.run({ effort })`.
Default `medium` (not `max`) — so cost/latency drop across the board unless the
lead or stage deliberately escalates. This directly addresses the audit: max only
where it pays.

## Why this shape
- **General**: one `EffortLevel` concept, mapped per adapter — works across
  runtimes, not DeepSeek-specific.
- **Lead-decided**: `create_subtask({ effort })` puts the call in the lead's hands
  per task, exactly as asked; stage defaults make the common case automatic.
- **Cheaper by default**: flipping the global default from `max` to `medium`, with
  opt-in escalation, is the single biggest lever on the audit's cost/latency tail.
- Composes with ADR 0014 (model tier on escalation): tier picks *which model*,
  effort picks *how hard it thinks* — orthogonal knobs.

## Alternatives considered
- **Keep effort in `runtimeOptions` only** (the typed escape hatch). Rejected:
  effort is a first-class, cross-runtime concern the lead sets routinely; burying
  it in per-adapter options hides it and duplicates mapping.
- **Per-stage only, no per-task override.** Rejected: the owner specifically wants
  the *lead* to decide per delegated task, not just per stage.
- **Leave the global `max`.** Rejected by the audit — wasteful on mechanical work.

## Consequences
- Effort becomes a tuned dial, not a fixed cost. Expect a material drop in the
  long-tail wake latency + output cost once the default is `medium`.
- One new generic option (`RunInput.effort`) + per-adapter mapping; one new
  `StageDef.effort` + a `create_subtask` param + engine resolution. No new engine
  mechanism beyond resolution.
- ADR 0014's `EFFORT_LEVEL=max` provider pin becomes the *default*, overridable.

## Build order (when implemented)
1. agent-loop `RunInput.effort` + per-adapter mapping (claude/codex/ai-sdk).
2. sikong: `StageDef.effort`, `create_subtask({ effort })`, engine resolution →
   `loop.run({ effort })`, workspace default `medium`.
3. Set stage defaults on built-in workflows (design/dialectic → high/max; others →
   medium). Dogfood: confirm the long-tail latency drops in the next audit.
