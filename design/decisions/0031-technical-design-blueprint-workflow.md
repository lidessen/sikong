# 0031 — Technical design blueprint workflow

Status: Accepted
Date: 2026-06-09
Relates: 0012 (adversarial dialectic), 0024 (grounded acceptance gates), 0028 (visual design split)

## Context

After the visual design workflow moved to `visual-design`, the generic `design`
workflow became technical/architectural design. The first technical design shape
was too generic: `design -> document -> review`. It could produce a useful
document, but it did not encode how the design should think.

Technical design is not a complete description of reality. It is a construction
blueprint: it tells builders what cannot move, what must be built in a specific
way, and where implementation judgment is allowed.

## Decision

`design@5` uses a staged blueprint workflow:

1. `world` — understand the world before designing. Use contradiction analysis
   to distinguish surface symptoms from the essence of the problem, identify the
   primary contradiction, secondary constraints, principal aspect, non-goals,
   and materially different readings or approaches.
2. `anchors` — extract stable design points: invariants, identities, ownership
   boundaries, trust and safety boundaries, lifecycle transitions, durability
   rules, and failure semantics. These are the points builders must not move.
3. `skeleton` — choose the smallest system skeleton that preserves the anchors:
   boundaries, state/data flow, control flow, persistence shape, and external
   interfaces.
4. `parts` — design modules, interfaces, policies, extension points, and the
   split between strict requirements and implementation flexibility.
5. `blueprint` — assemble the design document in concise, plain language. Use
   architecture, flow, or sequence diagrams only where they clarify construction.
6. `review` — submit blueprint evidence for lead acceptance. If the latest lead
   decision is rejected, the worker must revise the blueprint before resubmitting
   evidence.

The workflow keeps `design` as a compatibility summary field, but `blueprint` is
the final design artifact. `design@4` remains registered as `_DESIGN_WORKFLOW_V4`
so tasks pinned to the previous shape can replay.

## Why this shape

- It starts from problem understanding rather than solution inventory.
- It separates stable anchors from flexible implementation choices.
- It keeps architecture small enough to build while preserving the reasons it
  must not drift.
- It makes the final document useful to builders: strict areas and flexible
  areas are explicit.
- It avoids turning technical design into an implementation encyclopedia.

## Alternatives considered

- **Keep `design -> document -> review`.** Rejected: too underspecified; workers
  can jump directly to implementation-shaped documents without understanding the
  problem structure.
- **Use the visual-design philosophy pipeline for technical work.** Rejected:
  visual language derivation and preview tools are a different problem.
- **Generate a complete implementation plan in design.** Rejected: planning and
  construction should use the development workflow. Design should define the
  blueprint boundaries.

## Consequences

- Technical design tasks take more explicit intermediate steps, but each step is
  simple and reviewable.
- Review rejection has a clearer worker obligation: revise the blueprint, then
  resubmit evidence.
- Builders downstream get clearer constraints: what must be followed exactly and
  what can be adapted to local implementation context.
