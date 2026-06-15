# Sikong Design

This directory is the design source of truth for the current Sikong rewrite.

Read order:

1. `project-shape.md` - repository shape, package/process boundaries, and migration stance.
2. `workspace-management.md` - Sikong data dir, workspace registry, workspace preferences, and creation flow.
3. `coordination-engine.md` - durable PlanDef coordination, stage review, and multi-worker task flow.
4. `client-agent.md` - UI-embedded Client Agent shape and client work-log boundaries.
5. `console-ui-generation.md` - compact operations-console visual generation rules.
6. `command-surface.md` - shared command handler layer for CLI and tools.
7. `cli.md` - external-agent-facing CLI contract.
8. `daemon-runtime.md` - Go daemon supervision, Bun child-process concurrency, and runtime process boundaries.
9. `implementation-plan.md` - current phased implementation sequence and module boundaries.
10. Future area docs under this directory for storage details and runtime integration.

The current project is not a direct restore of `sikong-old/packages/sikong`.
Old code is source material. New code should be promoted through explicit
boundaries and tests.
