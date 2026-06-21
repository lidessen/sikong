# Sikong Design

This directory is the design source of truth for the current Sikong rewrite.

Read order:

1. `project-shape.md` - repository shape, package/process boundaries, and migration stance.
2. `workspace-management.md` - Sikong data dir, workspace registry, workspace preferences, and creation flow.
3. `development-philosophy.md` - shared Sikong / agent-worker design philosophy, drift signals, and review checklist.
4. `coordination-engine.md` - durable PlanDef coordination, stage review, and multi-worker task flow.
5. `recursive-agent-engine.md` - lower-level recursive problem-node kernel using divide-and-conquer, dynamic programming, artifacts, verification, and controlled commit.
6. `governance-model.md` - finite governance interpretation for Arch, Plan, Execute, and Verify authority boundaries.
7. `prompt-guidance.md` - prompt guidance theory: attention layers, attention boundaries, context projection, evidence compression, and operation prompt rules.
8. `assistant-agent-loop.md` - Rust assistant loop, real agent-loop host integration, dynamic capability injection, and agent-to-agent evaluation.
9. `dogfood.md` - Sikong self-development loop: doc-first tasks, repository analysis, patch tasks, live eval, and daily dogfood gates.
10. `client-agent.md` - UI-embedded Client Agent shape and client work-log boundaries.
11. `client-ui-user-stories.md` - operator-facing client UI stories and interaction hierarchy.
12. `console-ui-generation.md` - compact operations-console visual generation rules.
13. `command-surface.md` - shared command handler layer for CLI and tools.
14. `cli.md` - external-agent-facing CLI contract.
15. `daemon-runtime.md` - Go daemon supervision, Bun child-process concurrency, and runtime process boundaries.
16. `implementation-plan.md` - current phased implementation sequence and module boundaries.
17. Future area docs under this directory for storage details and runtime integration.

The current project is not a direct restore of `sikong-old/packages/sikong`.
Old code is source material. New code should be promoted through explicit
boundaries and tests.
