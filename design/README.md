# Sikong Design

This directory is the design source of truth for the current Sikong rewrite.

Read order:

1. `project-shape.md` - repository shape, package/process boundaries, and migration stance.
2. `workspace-management.md` - Sikong home, workspace registry, workspace preferences, and creation flow.
3. `coordination-engine.md` - durable PlanDef coordination, stage review, and multi-worker task flow.
4. `client-agent.md` - UI-embedded Client Agent shape and client work-log boundaries.
5. `command-surface.md` - shared command handler layer for CLI and tools.
6. `cli.md` - external-agent-facing CLI contract.
7. Future area docs under this directory for storage, daemon/API, and runtime integration.

The current project is not a direct restore of `sikong-old/packages/sikong`.
Old code is source material. New code should be promoted through explicit
boundaries and tests.
