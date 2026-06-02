# 0012 — Adversarial-dialectic design stage for the lead

Status: Accepted
Date: 2026-06-03

## Context

In the `development-lead` workflow the lead's `design` stage is where the
consequential, hard-to-reverse calls are made (architecture, language/stack,
interfaces, transports, testing approach). A dogfood run surfaced the failure
mode: building `shilu` from a design draft, the lead chose Go and recorded a
plausible rationale — but it never surfaced the strongest *counter*-argument
(shilu-agent is specified to use `agent-loop`, a TypeScript library, which argues
for TS). The decision was defensible, but the *reasoning was convergent*: it
settled on one answer without diverging across alternatives or arguing against
its own pick. A single agent asked to "design" tends to rationalize one path
rather than genuinely weigh several.

We want the lead's design to be **divergent then convergent** and
**adversarial** (steelman alternatives, pre-mortem the chosen one), and we want
the rejected alternatives **recorded** so the decision is auditable and
replayable.

## Decision

Make the lead's `design` stage produce an explicit adversarial record, using
only existing mechanism (fields + guards + instructions — no new engine
machinery):

1. **Field (`alternatives: json`)** added to `development-lead`. Its job is the
   enforceable part: presence, shape, and a durable audit trail. It holds a JSON
   array of `{ option, pros, why_rejected }`.
2. **Guard.** The `plan` stage's entry now also requires
   `alternatives exists` (alongside `design exists` + the transition). The lead
   cannot advance to planning without recording the rejected alternatives;
   reducer field-type validation already enforces it is JSON.
3. **Instructions.** The `design` stage prompt now demands the *thinking*: for
   the consequential decisions, identify 2-3 genuinely different candidates,
   steelman each, pre-mortem the preferred one, then converge — and record the
   seriously-considered-but-rejected options in `alternatives` (explicitly: no
   strawman padding).

### Division of labour (why field-constraints alone are not enough)

A field/guard can enforce that an `alternatives` record *exists* and is *shaped*
correctly; it cannot enforce that the thinking behind it was genuinely
adversarial or divergent. That quality comes from the **instructions**. The
field is necessary scaffolding (enforce + audit), not sufficient on its own.

### Scope (altitude)

This applies ONLY to the **lead's** `design` stage, where decisions are
consequential. The child `development` workflow's `design` stage is deliberately
left lightweight — leaf tasks ("add three constants") must not be burdened with a
dialectic ritual.

## Alternatives considered

- **Instructions only (no field/guard).** Rejected: nothing forces the record to
  exist or persist; not auditable, easy to skip.
- **Field/guard only (no instruction change).** Rejected: enforces a slot but
  not the reasoning — the lead fills it with token alternatives it never weighed.
- **Structural divergence: lead fans out independent "explore approach X"
  subtasks (reusing `create_subtask` + `childrenDone`), then synthesizes.** This
  is the strongest form — independent fresh-context agents genuinely diverge,
  where one agent self-critiquing tends to rationalize. Deferred as an **opt-in**
  for high-stakes design: it costs extra agent runs and should not be the default
  for every design. Kept as a future option precisely because it needs no new
  mechanism either.

## Consequences

- The lead's design decisions become auditable and replayable from durable state.
- Stays within sikong's task-agnostic vocabulary (fields/guards/instructions) —
  no coding-specific logic, no new engine mechanism. Consistent with ADR 0007.
- In-flight lead tasks already past `design` are unaffected (the new guard only
  gates `plan` entry); the workflow version is unchanged.
- If the lightweight form proves weak in dogfood, escalate to the opt-in
  structural-divergence form above.
