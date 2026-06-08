# 0028 — Target-aware design workflow (native / SwiftUI support)

Status: Accepted
Date: 2026-06-05
Extends: 0022 (philosophy-driven design workflow); complements 0024/0027 (acceptance)

## Context

The design workflow (`design@2`, ADR 0022) is philosophy-driven: frame → language →
derive → assemble → review. But `assemble` and `review` are hard-wired to the web:
the instructions say *"build … as real semajsx code"* / *"prefer `semajsx/ui`"* and
`design_preview` assumes HTML/CSS.

The first three stages are platform-agnostic — `frame` captures
content/audience/actions/density; `language` picks a philosophy from the catalog;
`derive` produces tokens (type scale, spacing, color roles, shape, elevation,
motion). The **catalog already contains Apple HIG** (§2 Clarity · Deference · Depth,
exemplars iOS/macOS), the right language for native Apple apps. And chiling's
`ChilingUI` is a SwiftUI app. So the design *thinking* already supports native; only
the *materialization* (assemble + preview) is web-bound.

## Decision — add a `target` and make assemble/review target-aware

- **`target` field** on the design workflow: `web-semajsx` (default) | `swiftui`
  (extensible later: `react`, `compose`, …). Captured at the **frame** stage
  alongside content/density.
- **derive** is unchanged — tokens are universal design decisions. The token →
  platform mapping is applied at assemble, not at derive.
- **assemble** branches on `target`:
  - `web-semajsx` → as today (real semajsx, `design_deliver`).
  - `swiftui` → write a SwiftUI **design system** derived from the tokens — a Swift
    file of `Color`/`Font`/spacing (`CGFloat`)/`cornerRadius`/`shadow`/`animation`
    constants + `ViewModifier` helpers — then the views, via `design_deliver` (it
    already writes arbitrary files, incl. `.swift`).
- **review/preview** branches on `target`:
  - `web-semajsx` → `design_preview` HTML bundles + owner visual review (as today).
  - `swiftui` → no in-agent preview; require **`swift build` evidence** so the lead
    can see that it at least compiles, then **owner visual review** (the agent can't
    see rendered pixels — more pronounced for native).

Version bump to `design@3`; keep the `design@2` definition registered for replay of
already-pinned tasks (same pattern as `_DESIGN_WORKFLOW_V1` for 0017). Note
(2026-06-08 cleanup): `design@2` is no longer retained — the `design` id now
means architectural/technical design, so old pins to `design@v2` would
semantically misload. The backward-compat constants for both `design@v1` and
`design@v2` were removed from `builtin.ts` in the visual-design/generic-design
split.

## Why this is the right shape

- Reuses the entire philosophy → language → derive pipeline (and the catalog,
  incl. Apple HIG) unchanged; native is purely a materialization target.
- Tokens stay universal — one derivation, many targets.
- Native review uses concrete compile evidence: `swift build` output is submitted
  before owner visual review, instead of trusting a self-report.

## Consequences

- Enables redesigning native apps (e.g. ChilingUI via Apple HIG) through the
  philosophy-driven workflow, not just functionally.
- `assemble`/`review` instructions become target-parameterized; `frame` gains
  `target`. No new stages, no new guard.
- Future targets slot in by adding a `target` value + an assemble/preview branch.
