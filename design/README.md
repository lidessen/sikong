# Sikong Design Registry

This directory is the design source of truth. Each document has a **status**,
a **governing layer**, and a **last-reviewed** date. Implementation must stay
within the boundaries set by current (✓) documents.

## Status Legend

| Mark | Status | Meaning |
|------|--------|---------|
| ✓ | Current | authoritative, implementation must follow |
| ◐ | Needs Review | likely still valid but should be checked before use |
| ✗ | Superseded | replaced by a newer document |
| + | Draft | proposed, not yet authoritative |

## Document Registry

### Layer L3: Architecture & Philosophy (stable)

| Status | Document | Governs | Last Reviewed |
|--------|----------|---------|---------------|
| ✓ | `development-philosophy.md` | All layers — core philosophy, attention method, drift signals | 2026-06-21 (Agent As Intelligent Node added) |
| ✓ | `governance-model.md` | All layers — Arch/Plan/Execute/Verify authority, gates | 2026-06-21 |
| ✓ | `prompt-guidance.md` | All layers — attention boundary, context projection | 2026-06-21 |
| ✓ | `dogfood.md` | Self-development loop — doc-first, live eval gates | 2026-06-21 |

### Layer L2: Engine & Runtime (semi-stable)

| Status | Document | Governs | Last Reviewed |
|--------|----------|---------|---------------|
| ✓ | `recursive-agent-engine.md` | `src/task_run/*`, `src/agent_run/*` | 2026-06-21 |
| ✓ | `workspace-management.md` | `src/workspace/*` | 2026-06-21 |
| ◐ | `coordination-engine.md` | `packages/agent-host/*`, `packages/agent-loop/*` | 2026-06-21 |
| ◐ | `assistant-agent-loop.md` | `src/assistant/*`, `packages/agent-host/*` | 2026-06-21 |

### Layer L1: Command & Interface (evolving)

| Status | Document | Governs | Last Reviewed |
|--------|----------|---------|---------------|
| ✓ | `cli-architecture.md` | `src/main.rs`, `src/cli.rs`, `src/config.rs`, `src/agent_run/run_scheduler.rs` | 2026-06-22 |
| ✓ | `eval-framework.md` | `src/cli.rs` eval commands, `evals/task-run/*.yaml`, `design/recursive-agent-engine.md` §Live Eval Mode | 2026-06-22 |
| ✓ | `assistant-agent-protocol.md` | `src/assistant/acp.rs`, external agent integrations | 2026-06-22 |
| ◐ | `command-surface.md` | `src/cli.rs` CLI parsing and dispatch | 2026-06-21 |
| ◐ | `cli.md` | `src/cli.rs` external contracts | 2026-06-21 |
| ◐ | `daemon-runtime.md` | `cmd/sikongd/*`, legacy Go daemon | 2026-06-21 |

### Layer L0: Client & UI (fast-moving)

| Status | Document | Governs | Last Reviewed |
|--------|----------|---------|---------------|
| ✗ | `client-agent.md` | `packages/client/*`, legacy UI | pre-cleanup |
| ✗ | `client-ui-user-stories.md` | `packages/client/*`, legacy UI | pre-cleanup |
| ✗ | `console-ui-generation.md` | `packages/client/*`, legacy UI | pre-cleanup |

### Cross-Cutting

| Status | Document | Governs | Last Reviewed |
|--------|----------|---------|---------------|
| ◐ | `project-shape.md` | Repository layout and migration stance | 2026-06-21 |
| ◐ | `implementation-plan.md` | Current phased implementation sequence | 2026-06-21 |

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
