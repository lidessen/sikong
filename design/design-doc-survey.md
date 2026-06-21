# Design Document Survey Report

Generated: 2026-06-22

## Purpose

This report catalogs all `design/*.md` documents in the Sikong workspace. For
each document it states the title/purpose, structure, scope and claims, maps the
doc to code subsystems, and flags whether the doc belongs to the Go/Bun era and
may be outdated relative to the current Rust mainline architecture.

---

## Document 1: `design/README.md`

- **Title/Purpose**: Sikong Design Registry
  Registry index for all design documents, with status legend, governance layer
  assignment, and last-reviewed dates. Defines design discipline rules (6 rules).

- **Scope & Claims**: Maintains the registry of all 15 actual design documents.
  Claims that design updates must precede code changes, that status updates are
  part of design review, and that implementation must cite its governing design.

- **Code Subsystem Mapping**: Cross-cutting (registry/index — no code mapping)

- **Outdated/Go-Bun Era**: **No** — this is the current design index.

---

## Document 2: `design/development-philosophy.md`

- **Title/Purpose**: Development Philosophy
  Core design philosophy for Sikong development: the "Agent As Intelligent Node"
  pattern, lower-level operating method (attention boundary, steered system
  model, falsifiable facts), shared laws, drift signals, and review checklist.

- **Scope & Claims**: Covers all layers. Central thesis: adding agents should
  make the system simpler, more stable, and more powerful. Defines the
  Rust-is-deterministic/Bun-is-intelligent boundary. Describes the agent-worker
  swarm-harness philosophy. Lists 10 shared laws and 14 drift signals.

- **Code Subsystem Mapping**: All layers (philosophical/cross-cutting).
  References `src/task_run/*`, `src/agent_run/*`, workspace providers,
  verification gates, dogfood evals. References `../agent-worker/design/`
  external design anchors.

- **Outdated/Go-Bun Era**: **No** — this is current philosophy guiding the Rust
  mainline. Dated 2026-06-21.

---

## Document 3: `design/governance-model.md`

- **Title/Purpose**: Governance Model
  Defines the four governance layers (Arch/Plan/Execute/Verify) and their
  authority boundaries. Maps governance to existing `NodeOperation` variants.
  Lists hard gate rules (G-ARCH-ESCAPE, G-SCOPE-WIDEN, G-PROTOCOL, G-CHECK-FAIL,
  etc.), finite decomposition guidelines, and an incremental implementation path.

- **Scope & Claims**: Covers all layers — the governance model is the operating
  constitution for recursive task execution. Claims Arch owns the system frame,
  Plan owns routing, Execute owns local work, Verify owns gates. Commit is
  engine-side, not a governance layer. Finite decomposition depth of 2-3 levels.

- **Code Subsystem Mapping**: `src/task_run/*` (NodeOperation, GovernanceLayer,
  GovernanceGate types in Rust `types.rs`), engine state transitions.

- **Outdated/Go-Bun Era**: **No** — current Rust-era document. Dated 2026-06-21.

---

## Document 4: `design/prompt-guidance.md`

- **Title/Purpose**: Prompt Guidance Theory
  Defines the prompt-shaping theory: attention layers (L0–L3), attention
  boundary rule, prompt section shape, prompt tuning discipline, dogfood
  feedback discipline, and per-operation guidance for
  Specify/Plan/Execute/Combine/Verify. Defines the "prompt is a context
  projection, not a chat transcript" principle.

- **Scope & Claims**: Covers all layers — prompt construction methodology for
  Sikong's Rust agent engine. Claims prompts should project the current
  operation's attention boundary and let the agent own local execution.
  Prescribes repair order (reduce context → tighten schema → adjust prose).
  Defines compression and evidence standards.

- **Code Subsystem Mapping**: Cross-cutting. References
  `packages/agent-host/*`, `packages/agent-loop/*`, prompt construction in Rust
  harness code. Also references runtime profiles (general/code) and the
  agent-run protocol.

- **Outdated/Go-Bun Era**: **No** — current Rust-era document defining the
  active prompt method. Dated 2026-06-21.

---

## Document 5: `design/dogfood.md`

- **Title/Purpose**: Dogfood Development
  Defines how Sikong uses Sikong to improve itself. Dogfood is an operating
  model over the recursive task-run engine, not a separate engine. Describes
  the dogfood attention contract, task types (design doc, repository analysis,
  patch, verification), design-first start, dogfood pack, closed development
  loop with three modes (review-only, patch-proposal, apply), commit and
  runtime update gate, live eval strategy, evidence tiers, and success criteria.

- **Scope & Claims**: Covers the self-development loop. Claims dogfood should
  start with a design-doc task, use the governance model as its operating
  constitution, and name the attention boundary before every meaningful run.
  Three live eval levels: cheap routing eval, operation matrix, full task eval.

- **Code Subsystem Mapping**: `evals/task-run/*` (scenario YAML fixtures,
  dogfood eval scenarios), `development-log/`, `design/*` (design docs as
  modification targets). References the CLI eval commands and
  `packages/agent-loop/*`.

- **Outdated/Go-Bun Era**: **No** — current Rust-era document. Dated 2026-06-21.

---

## Document 6: `design/recursive-agent-engine.md`

- **Title/Purpose**: Recursive Agent Engine
  Defines the lower-level engine model: recursive apply of
  divide-and-conquer + dynamic programming via
  `Resolve → Specify → Plan → Execute → Combine → Verify → Commit`. Describes
  the Rust/Bun split, agent-run protocol, operation harnesses, tool catalog,
  live eval mode, standard node operations, dynamic programming tables (memo,
  attempt, frontier), workspace abstraction with providers (Memory, FileSystem,
  GitFileSystem, etc.), Git workspace implementation, core data structures,
  engine loop, policy packs, and migration path.

- **Scope & Claims**: L2 Engine & Runtime. This is the central engine
  architecture document. Claims Rust owns deterministic control (state machines,
  DP tables, scheduling, verification) and Bun owns execution (model API, agent
  loops, tool calls). Defines the full agent-run protocol (AgentRunRequest,
  AgentRunResponse, JSONL transport over Unix socket). Lists 7 workspace
  provider types. Defines NodeOperation as a 6-element enum.

- **Code Subsystem Mapping**: `src/task_run/*`, `src/agent_run/*`,
  `packages/agent-host/*`, `packages/agent-loop/*`. Specifically: engine.rs
  (control flow), types.rs (data structures), ProcessAgentRunScheduler (Unix
  socket transport), agent-host runtime, agent-loop worker.

- **Outdated/Go-Bun Era**: **No** — this is the definitive Rust-era engine
  design. Dated 2026-06-21.

---

## Document 7: `design/workspace-management.md`

- **Title/Purpose**: Workspace Management
  Defines Sikong's workspace concept — a project-level namespace under the
  local Sikong data dir (`~/.sikong/`). Describes terminology, data dir layout,
  settings (config.yaml), workspace definition (id, name), workspace store,
  git worktrees, workspace preferences, preferences read/write policy,
  workspace resolution, and commands.

- **Scope & Claims**: L2 Engine & Runtime. Claims workspace is Sikong's
  project-level namespace replacing the earlier `project` term. Agent runs
  must receive a workspace-derived cwd. Worktree is owned by workspace, not by
  workspace definition. Preferences are lead-controlled, not auto-injected.

- **Code Subsystem Mapping**: `src/workspace/*` (Rust workspace management),
  `packages/workspace/*` (TypeScript coordination engine). Specifically:
  data-dir layout, WorkspaceDef, WorkspaceStore, WorkspacePreferences,
  FileWorkspacePreferences.

- **Outdated/Go-Bun Era**: **No** — current Rust-era document describing the
  active workspace model. Dated 2026-06-21.

---

## Document 8: `design/coordination-engine.md`

- **Title/Purpose**: Coordination Engine
  Defines the durable multi-worker coordination layer above `agent-loop`.
  Describes roles (Lead, Planner, Stage Worker, Stage Reviewer, Final Reviewer),
  review policy, engine loop, core state machine, plan lifecycle, PlanDef,
  StageRoundDef, stage execution, stage review, final review, event model,
  relationship to old workflow model and agent-loop.

- **Scope & Claims**: L2 Engine & Runtime (semi-stable). This is the
  TypeScript/Bun-era coordination protocol. Claims the TypeScript engine owns
  task coordination; Go daemon is just a process supervisor. Defines a fixed
  state machine with TaskPhase (7 states) and coordinated stage-round/work-unit
  execution. The Event Model lists 30 core events.

- **Code Subsystem Mapping**: `packages/agent-host/*`, `packages/agent-loop/*`,
  `packages/workspace/src/coordination/*`, `packages/workspace/src/commands/*`.

- **Outdated/Go-Bun Era**: **Yes** — this describes the TypeScript/Go
  coordination engine, which is the legacy architecture being replaced by the
  Rust recursive agent engine (`recursive-agent-engine.md`). Marked as ◐ Needs
  Review. The Rust mainline engine supersedes this architecture. Dated
  2026-06-21.

---

## Document 9: `design/assistant-agent-loop.md`

- **Title/Purpose**: Assistant Agent Loop
  Defines the Rust assistant agent loop. Describes ownership boundary (Rust
  owns business context, Bun owns the runtime bridge), assistant pack injection
  (AssistantPack trait, core pack, task-board pack), real agent loop,
  agent-to-agent evaluation, and test tiers.

- **Scope & Claims**: L2 Engine & Runtime (semi-stable). Claims the assistant
  is the user-facing coordinator that does not execute recursive engine work
  directly. The assistant chooses tools and finishes with a terminal tool.
  Defines the AssistantPack trait and pack injection.

- **Code Subsystem Mapping**: `src/assistant/*` (Rust assistant harness),
  `packages/agent-host/*` (Bun runtime bridge), `packages/agent-loop/*`.

- **Outdated/Go-Bun Era**: **Partial** — describes the Rust assistant but
  still depends on the Bun agent-host bridge (`@sikong/agent-host`). The
  assistant is part of the current Rust mainline, but the Bun dependency may
  be transitional. Marked as ◐ Needs Review. Dated 2026-06-21.

---

## Document 10: `design/command-surface.md`

- **Title/Purpose**: Command Surface
  Defines the shared application layer beneath both CLI and UI tool adapter.
  Describes ownership (adapters own transport, handlers own application
  actions, engine owns coordination semantics), result shape (CommandResult),
  context (CommandContext), initial commands (workspaces, preferences, tasks,
  inspect), error codes, forbidden shortcuts, and implementation order.

- **Scope & Claims**: L1 Command & Interface (evolving). Claims command
  handlers are request-scoped and must not rely on global mutable state.
  Defines ~30 command-handler functions across workspace, preference, task,
  and inspect groups. Lists ~20 stable error codes.

- **Code Subsystem Mapping**: `src/cli.rs` (CLI parsing and dispatch),
  `packages/workspace/src/commands/*` (TypeScript command handlers),
  `packages/workspace/src/tools/*` (tool adapter).

- **Outdated/Go-Bun Era**: **Partial** — the command handlers are implemented
  in TypeScript under `packages/workspace`. Marked as ◐ Needs Review. The
  command surface concept is being carried over into the Rust mainline but the
  current implementation is still in the TypeScript/Go layer. Dated 2026-06-21.

---

## Document 11: `design/cli.md`

- **Title/Purpose**: CLI
  Defines the Sikong CLI as an agent-facing local tool. Describes callers
  (external agent, human operator, scripts/CI), output contract (JSON by
  default), global flags, command shape (resource-first), workspace commands,
  preference commands, task commands, inspect commands, daemon commands,
  adapter rule, and one-shot process model.

- **Scope & Claims**: L1 Command & Interface (evolving). Claims the primary
  caller is an external agent (Claude Code, Codex, etc.). CLI commands must
  call shared command handlers. The CLI is one-shot (one invocation → one Bun
  process → one result).

- **Code Subsystem Mapping**: `src/cli.rs` (Rust CLI entrypoint),
  `cmd/sikong/*` (Go CLI adapter).

- **Outdated/Go-Bun Era**: **Partial** — describes the CLI as a Go/Bun
  process adapter. With the Rust mainline, the CLI entrypoint is migrating
  to Rust (`src/cli.rs`). Marked as ◐ Needs Review. Dated 2026-06-21.

---

## Document 12: `design/daemon-runtime.md`

- **Title/Purpose**: Daemon And Runtime Processes
  Defines the Go daemon layer as a host-process concerns owner. Describes the
  two process shapes (CLI one-shot, daemon supervisor), daemon API endpoints
  (10 REST endpoints on `127.0.0.1:8765`), Go responsibilities, TypeScript
  responsibilities, concurrency rule, storage safety, and implementation order.

- **Scope & Claims**: L1 Command & Interface (evolving). Claims the Go daemon
  is a generic process supervisor that does not know about planner/worker/
  reviewer roles. The daemon must not use a single long-running Bun engine.
  The daemon owns local API, process lifecycle, cancellation, timeout, and
  concurrency. TypeScript owns coordination semantics.

- **Code Subsystem Mapping**: `cmd/sikongd/*` (Go daemon entrypoint),
  `internal/daemon/*` (Go daemon implementation), `packages/workspace/src/process/*`
  (TypeScript process client and runner).

- **Outdated/Go-Bun Era**: **Yes** — this describes the Go daemon architecture,
  which is the legacy/transitional runtime layer. The Rust mainline is replacing
  the Go daemon. Marked as ◐ Needs Review. Dated 2026-06-21.

---

## Document 13: `design/client-agent.md`

- **Title/Purpose**: Client Agent
  Defines the UI-embedded Client Agent — the agent embedded in the client
  experience. Describes role names, task naming, client interaction model,
  turn stream, source stores, bootstrap context, visual direction, tool surface,
  and wait/monitor modes.

- **Scope & Claims**: L0 Client & UI (fast-moving). Claims the Client Agent
  is not the internal Task Lead. The transcript is presentation state, not
  authoritative project state. Defines the full ClientAgentBootstrapContext
  shape, MessagePart types, and SikongUISpec catalog.

- **Code Subsystem Mapping**: `packages/client/*` (React/Vite UI), `packages/workspace/src/client-agent/*`,
  `packages/workspace/src/tools/*`, `packages/workspace/src/commands/*`.

- **Outdated/Go-Bun Era**: **Yes** — explicitly marked as ✗ Superseded in the
  design registry. Dated pre-cleanup. The client architecture is being reworked
  in the Rust mainline.

---

## Document 14: `design/client-ui-user-stories.md`

- **Title/Purpose**: Client UI User Stories
  Defines the operator-facing interaction model for the Sikong client UI.
  Lists 10 user stories with acceptance criteria, describes interaction
  architecture (chat, work detail, work unit drawer, logs), and design rules.

- **Scope & Claims**: L0 Client & UI (fast-moving). Claims the primary user
  is the client-agent operator. The UI should expose goals, plans, progress,
  decisions, and drill-down evidence. Default to user-decision information,
  hide implementation mechanics until drill-down.

- **Code Subsystem Mapping**: `packages/client/*` (React/Vite UI components).

- **Outdated/Go-Bun Era**: **Yes** — explicitly marked as ✗ Superseded in the
  design registry. Dated pre-cleanup.

---

## Document 15: `design/console-ui-generation.md`

- **Title/Purpose**: Console UI Generation Spec
  Defines visual generation rules for Sikong's console UI. Describes output
  contract, visual intent, design tokens (CSS variables for dark/light themes),
  density baseline (13px base, compact controls), primitive specs (button,
  input, badge, panel, card, table), layout system, responsiveness, and
  anti-drift rules.

- **Scope & Claims**: L0 Client & UI (fast-moving). Claims the product type
  is an operations console, not a marketing website. Defines a complete CSS
  design token system for dark and light themes. Defines preferred metrics
  (top bar ~46px, rail ~286px, button ~26px, etc.).

- **Code Subsystem Mapping**: `packages/client/*` (React/Vite UI component
  implementation, CSS/theme implementation).

- **Outdated/Go-Bun Era**: **Yes** — explicitly marked as ✗ Superseded in the
  design registry. Dated pre-cleanup.

---

## Document 16: `design/project-shape.md`

- **Title/Purpose**: Project Shape
  Defines the intended repository layout and architectural layers for the
  Sikong project. Describes the three-layer boundary (Go CLI/daemon →
  workspace coordination engine → agent-loop), repository layout (cmd/,
  internal/, packages/, design/), workspace package structure, migration
  policy from old sikong, process boundary, caller surfaces, and state layout.

- **Scope & Claims**: Cross-cutting. Claims the old Go/Bun architecture has
  three layers, TypeScript owns coordination semantics, Go is just process
  supervisor. Defines the target repo layout. Lists what moves from old sikong
  and what does not move initially.

- **Code Subsystem Mapping**: Cross-cutting — the entire repository layout.
  References `cmd/sikong/*`, `cmd/sikongd/*`, `internal/*`, `packages/agent-loop/*`,
  `packages/workspace/*`, `packages/client/*`, `design/*`.

- **Outdated/Go-Bun Era**: **Partial** — describes the Go/TypeScript
  architecture transition. With the Rust mainline advancing, the three-layer
  model is being replaced by the Rust-controlled engine + Bun agent-execution
  model. Marked as ◐ Needs Review. Dated 2026-06-21.

---

## Document 17: `design/implementation-plan.md`

- **Title/Purpose**: Implementation Plan
  Records the current implementation sequence for the Sikong rewrite. 16 phases
  (Phase 1–16), each with status (implemented/not implemented), deliverables,
  and constraints. Lists the current baseline of implemented features and not-yet-
  implemented features.

- **Scope & Claims**: Cross-cutting. Claims the implementation must preserve
  fixed boundaries: Go daemon is generic process supervisor, TypeScript owns
  coordination, worker is the only executable agent unit, etc. Phase 16 (Task
  Lead and Stage Rounds) is the only unimplemented phase.

- **Code Subsystem Mapping**: Cross-cutting — maps to all code subsystems
  across the entire repository. References `packages/workspace/src/*`,
  `internal/daemon/*`, `cmd/sikong/*`, `cmd/sikongd/*`.

- **Outdated/Go-Bun Era**: **Yes** — the implementation plan describes the
  Go/Bun/TypeScript implementation sequence. The Rust mainline has diverged
  from many of these phases. Marked as ◐ Needs Review. Dated 2026-06-21.

---

## Summary Table

| #  | Document | Status | Layer | Code Subsystems | Go/Bun Era |
|----|----------|--------|-------|-----------------|------------|
| 1  | README.md | ✓ | — | Cross-cutting (index) | No |
| 2  | development-philosophy.md | ✓ | L3 | All layers (philosophical) | No |
| 3  | governance-model.md | ✓ | L3 | src/task_run/*, types.rs | No |
| 4  | prompt-guidance.md | ✓ | L3 | All layers (prompt method) | No |
| 5  | dogfood.md | ✓ | L3 | evals/task-run/*, development-log/ | No |
| 6  | recursive-agent-engine.md | ✓ | L2 | src/task_run/*, src/agent_run/*, packages/agent-host/*, packages/agent-loop/* | No |
| 7  | workspace-management.md | ✓ | L2 | src/workspace/*, packages/workspace/* | No |
| 8  | coordination-engine.md | ◐ | L2 | packages/agent-host/*, packages/agent-loop/*, packages/workspace/src/coordination/* | **Yes** |
| 9  | assistant-agent-loop.md | ◐ | L2 | src/assistant/*, packages/agent-host/* | Partial |
| 10 | command-surface.md | ◐ | L1 | src/cli.rs, packages/workspace/src/commands/* | Partial |
| 11 | cli.md | ◐ | L1 | src/cli.rs, cmd/sikong/* | Partial |
| 12 | daemon-runtime.md | ◐ | L1 | cmd/sikongd/*, internal/daemon/*, packages/workspace/src/process/* | **Yes** |
| 13 | client-agent.md | ✗ | L0 | packages/client/*, packages/workspace/src/client-agent/* | **Yes** |
| 14 | client-ui-user-stories.md | ✗ | L0 | packages/client/* | **Yes** |
| 15 | console-ui-generation.md | ✗ | L0 | packages/client/* | **Yes** |
| 16 | project-shape.md | ◐ | — | Cross-cutting (repo layout) | Partial |
| 17 | implementation-plan.md | ◐ | — | Cross-cutting (all subsystems) | **Yes** |

*Status: ✓ = Current / ◐ = Needs Review / ✗ = Superseded*

---

## Outdated Document Summary

Documents flagged as Go/Bun era (either explicitly superseded, or describing
architectural layers that the Rust mainline is replacing):

| Document | Reason |
|----------|--------|
| `coordination-engine.md` | TypeScript/Go coordination engine superseded by Rust recursive agent engine |
| `daemon-runtime.md` | Go daemon architecture being replaced by Rust-native runtime |
| `client-agent.md` | Explicitly ✗ Superseded; client architecture being reworked |
| `client-ui-user-stories.md` | Explicitly ✗ Superseded |
| `console-ui-generation.md` | Explicitly ✗ Superseded |
| `implementation-plan.md` | Go/Bun/TypeScript implementation plan diverged from Rust mainline |

Partially outdated (describe transitional architecture but still inform current work):

| Document | Reason |
|----------|--------|
| `assistant-agent-loop.md` | Rust assistant depends on Bun agent-host bridge (transitional) |
| `command-surface.md` | TypeScript command handlers being migrated to Rust |
| `cli.md` | Go/Bun CLI adapter being replaced by Rust CLI |
| `project-shape.md` | Repository layout evolving with Rust mainline migration |

---

## Appendix: Design Registry Cross-Check

All 16 design `*.md` files in the workspace are accounted for in this survey.
The filesystem enumerates exactly the documents listed in `design/README.md`.
No orphan or unregistered design documents were found.
