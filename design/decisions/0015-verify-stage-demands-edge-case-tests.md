# 0015 — The verify stage demands adversarial/edge-case tests + a real-user-path smoke

Status: Accepted
Date: 2026-06-03

## Context

Across dogfood rounds, `development` tasks repeatedly shipped code whose tests
were green but shallow — happy-path only, over convenient inputs:
- the shilu auto-index task didn't fully cover create→search-without-rebuild;
- the shilu FTS5 task's tests used safe words ("Go") and missed operator/hyphen
  queries, so `search "auto-index usable"` **crashed in real use** ("no such
  column: index") despite a passing test suite.

Both were caught only by a human actually using the tool. The verify stage's bar
("verify with appropriate checks") was too weak to catch this.

## Decision

Strengthen the `development` workflow's `verify` stage instructions to demand
**adversarial verification**: run the project's full checks, and require tests
that cover **edge cases and realistic inputs** (boundary, special characters,
multi-token, reserved words, error paths) and that **exercise the actual
user-facing entry point end-to-end** the way a user invokes it — explicitly
stating that green unit tests over safe inputs are not enough. The worker must
record the exact commands run and their results.

This is prompt steering only — no new mechanism, no host-side gate (ADR 0007
keeps coding/verify semantics out of the engine). It raises the deliverable's
acceptance bar in the workflow's own instructions; the engine stays
task-agnostic.

## Alternatives considered

- **A host-side gate that inspects test quality.** Rejected — re-introduces the
  coding-ACI the engine shed in ADR 0007, and "tests are adversarial" can't be
  mechanically verified anyway.
- **A separate reviewer/adversary subtask per task.** Heavier; reserve for
  high-stakes work. The instruction change is the cheap first move; escalate to a
  reviewer pass later if shallow tests persist.

## Consequences

- Future dogfood tasks should smoke the real user path and test edge cases,
  reducing green-but-broken deliverables. To be observed over subsequent runs.
- Scoped to the leaf `development` verify stage (where implementation+tests
  happen); the lead's review can still spot-check.
