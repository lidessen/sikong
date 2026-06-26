# Sikong Design Registry

This directory is the design source of truth. Each document has a **status**,
a **governing layer**, and a **last-reviewed** date. Implementation must stay
within the boundaries set by current (✓) documents.

## Status Legend

| Mark | Status       | Meaning                                             |
| ---- | ------------ | --------------------------------------------------- |
| ✓    | Current      | authoritative, implementation must follow           |
| ◐    | Needs Review | likely still valid but should be checked before use |
| ✗    | Superseded   | replaced by a newer document                        |
| +    | Draft        | proposed, not yet authoritative                     |

## Document Registry

### Layer L3: Architecture & Philosophy (stable)

| Status | Document                               | Governs                                                             | Last Reviewed                                |
| ------ | -------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| ✓      | `philosophy/development-philosophy.md` | All layers — core philosophy, attention method, drift signals       | 2026-06-21 (Agent As Intelligent Node added) |
| ✓      | `philosophy/governance-model.md`       | All layers — Arch/Plan/Execute/Verify authority, gates              | 2026-06-21                                   |
| ✓      | `philosophy/prompt-guidance.md`        | All layers — attention boundary, context projection                 | 2026-06-21                                   |
| ✓      | `philosophy/dogfood.md`                | Self-development loop — doc-first, live eval gates                  | 2026-06-21                                   |
| ✓      | `philosophy/development-theory.md`     | All layers — development method, debt management, iteration cadence | 2026-06-22                                   |
| ✓      | `philosophy/product-vision.md`         | All layers — strategic direction, roadmap, iteration decisions      | 2026-06-22                                   |
| —      | `philosophy/down-to-earth.md`          | Practical methodology — plain-language principles                   | —                                            |
| —      | `philosophy/practice-theory-unity.md`  | Dogfood cycle principles — practical unity of theory and practice   | —                                            |

## Design Discipline

1. **A design document must be Current (✓) to be authoritative.**
   Code should not be guided by Needs-Review or Draft documents without
   explicit acknowledgment of the risk.

2. **Implementation must cite its governing design.**
   Commit messages, PR descriptions, and eval scenarios should reference
   the specific design doc and section that authorizes the change.

3. **Design changes are separate commits from code changes.**
   A design update commit must stand alone and be reviewable before the
   implementation commit that follows it. This enforces the attention
   boundary between the stable and fast layers.

4. **When a design drifts from implementation, update the design.**
   If implementation reveals that the design is wrong or incomplete, the
   design must be corrected — not silently ignored. Record the drift and
   the correction in the dev-log.

5. **New capabilities require a design document before implementation.**
   A draft design document must be reviewed and promoted to Current before
   the first implementation commit. The one exception is bug fixes that
   do not change architectural contracts.

6. **Status updates are part of the design review.**
   When a design document is reviewed and found still valid, update the
   Last Reviewed date. When it's superseded, mark it ✗ and link to the
   replacement.
