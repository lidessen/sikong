# Sikong Design

This directory is the design source of truth for the current Sikong rewrite.

Read order:

1. `project-shape.md` - repository shape, package/process boundaries, and migration stance.
2. `workspace-management.md` - Sikong data dir, workspace registry, workspace preferences, and creation flow.
3. `coordination-engine.md` - durable PlanDef coordination, stage review, and multi-worker task flow.
4. `recursive-agent-engine.md` - lower-level recursive problem-node kernel using divide-and-conquer, dynamic programming, artifacts, verification, and controlled commit.
5. `assistant-agent-loop.md` - Rust assistant loop, real agent-loop host integration, dynamic capability injection, and agent-to-agent evaluation.
6. `client-agent.md` - UI-embedded Client Agent shape and client work-log boundaries.
7. `client-ui-user-stories.md` - operator-facing client UI stories and interaction hierarchy.
8. `console-ui-generation.md` - compact operations-console visual generation rules.
9. `command-surface.md` - shared command handler layer for CLI and tools.
10. `cli.md` - external-agent-facing CLI contract.
11. `daemon-runtime.md` - Go daemon supervision, Bun child-process concurrency, and runtime process boundaries.
12. `implementation-plan.md` - current phased implementation sequence and module boundaries.
13. Future area docs under this directory for storage details and runtime integration.

The current project is not a direct restore of `sikong-old/packages/sikong`.
Old code is source material. New code should be promoted through explicit
boundaries and tests.
