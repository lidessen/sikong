# 0022 — Philosophy-driven design workflow (supersedes 0017)

Status: Accepted
Date: 2026-06-04
Supersedes: 0017 (design workflow)

## Context

ADR 0017's design workflow diverges *visual looks* and converges on one — it
operates at the pixel/theme altitude. The owner's refinement (2026-06-04): real
design is **philosophy-first; parameters are derived**. A theme is not a design;
a **design language** is a *visual-expression philosophy* — e.g. minimalism is not
"less stuff", it is *"omit ornament so content and the single primary action carry
all the weight; hierarchy comes from space and type, not decoration."* With the
philosophy as the 指导思想 (guiding principle), the next phase can **derive concrete
parameters 因地制宜** (button shape, borders, shadows, color roles) instead of
pulling tokens from a grab-bag. semajsx exists to **cut the cost of *describing* the
UI**, so the workflow spends its budget on design *thinking*, not boilerplate.

## Decision

Rebuild the `design` workflow as a philosophy-driven pipeline:

1. **frame** — classify what is being expressed (blog / article / product /
   docs / admin / …) and capture goals, audience, key actions, information
   architecture, density (read vs scan vs operate). Output: `frame`. Everything
   downstream bends to this.
2. **language** — **diverge 2-3 candidate design LANGUAGES** (philosophies, from
   the catalog) suited to the frame; steelman each (what it *omits*, what it
   *elevates*, the feeling/values, and *why*); **converge** on one. The dialectic
   (ADR 0012) lives HERE, at philosophy altitude — not at pixels. Guarded: a
   required `language` field capturing the chosen philosophy + its rationale, and
   `alternatives` (the rejected languages + why). Cannot proceed to params without it.
3. **derive (因地制宜)** — from `language` + `frame`, DERIVE the concrete design
   system: type scale, spacing rhythm, color roles, shape (radius/border),
   elevation/shadow, motion, and per-component treatments (button/input/card/nav).
   **Each parameter must cite its philosophical justification** ("hairline borders
   ← minimalism omits ornament"). Output: `designSpec`. Derivation, not selection.
4. **assemble** — build it in semajsx from the derived spec, preferring
   language-parameterized `semajsx/ui`. (This is where semajsx earns its keep:
   near-zero-cost UI description.)
5. **review** — preview and evaluate **against the chosen philosophy** and the
   frame's goals; iterate. The human-in-the-loop visual check happens here (see
   "Honest limit"); approval gate before deliver/done.

### The design-language catalog

A curated set of **root design languages** (each = philosophy + what-it-omits /
what-it-elevates + derivation rules + best-fit content types), seeded in
`design/design-language-catalog.md`. The `language` stage **selects and adapts**
from it rather than reinventing one each run; it is extensible. The catalog is the
shared vocabulary between the workflow (sikong) and the substrate (semajsx).

### semajsx's role

`semajsx/ui` should be **parameterized by a design-language spec** (a derived
`designSpec` themes the whole component set), not hardcoded shadcn clones — so
"express this minimal button" costs almost nothing. This is the cost reduction the
owner is targeting and the bridge to the design-system north star.

## Honest limit (visual review)

The agent cannot *see* rendered pixels, so "视觉评审" is the weakest link. Mitigations:
(1) derivation-justified params are checkable from code; (2) review judges
coherence-with-the-stated-philosophy, not raw aesthetics; (3) an explicit **owner
visual-review/approval point** on a live preview. A render→screenshot bridge for
agent-side visual checking is future work, not assumed.

## Alternatives considered
- **Keep 0017 (diverge looks → converge).** Rejected: wrong altitude — it picks
  surfaces without a philosophy, so results are generic and params are arbitrary.
- **Skip `frame`, go straight to language.** Rejected: a docs site, an admin
  console, and a landing page demand different languages; content type is the first
  constraint, not an afterthought.
- **Per-run reinvented styles (no catalog).** Rejected: wastes budget and yields
  incoherent one-offs; a curated language catalog gives reuse + a quality floor.

## Consequences
- Design output becomes coherent and auditable (every param traces to a philosophy).
- The dialectic moves to the decision that matters (which language), not pixels.
- semajsx evolves toward language-parameterized `ui`; the catalog couples the two.
- Supersedes 0017's stage shape; reuses ADR 0012 (dialectic), the
  `design_preview`/`design_deliver` tools, and approval gates.

## Cleanup
2026-06-08: the `_DESIGN_WORKFLOW_V2` backward-compat constant was removed from
`builtin.ts` as part of the visual-design/generic-design workflow split. The
visual/philosophy-first pipeline now lives as `VISUAL_DESIGN_WORKFLOW` (id
`visual-design`, version 3+), and `DESIGN_WORKFLOW` (id `design`, version 4) is
the generic architectural/technical design workflow. Old pins to `design@v2` are
semantically wrong since `design` now means architectural design, so a hard
error is safer than a silent misload.

## Build order (delegated to sikong)
1. Rebuild `DESIGN_WORKFLOW` as `frame → language → derive → assemble → review`
   with the guarded `language`/`alternatives` + justified `designSpec`.
2. Load the catalog so the `language` stage can select/adapt from it.
3. Evolve `semajsx/ui` toward design-language-spec parameterization.
4. Dogfood on sikong.dev (re-derive it from an explicit chosen language).
