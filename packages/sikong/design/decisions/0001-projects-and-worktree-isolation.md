# 0001 — Projects as first-class entities; worktree isolation for parallel branches

Status: **Proposed (deferred — record now, build later)**
Date: 2026-05-31

## Context

The whole point of sikong is parallelism across **multiple projects** and
many tasks per project, driven from one or more lead-agent (Claude Code / Codex)
entry points. Today the kernel already carries a `projectId` on every `Task`
(`src/workflow/types.ts`), but there is **no first-class Project entity** — no way
to create/register a project, no per-project isolation, no per-project defaults.

Separately, real engineering work needs **branch-level parallelism**: several tasks
working on the same repo at once must not clobber each other's working tree. The
clean answer is one **git worktree per task/branch** so they run in isolation —
agent-loop already has an `isolation: "worktree"` notion for its agents.

## Decision

1. **Project is a first-class, registerable entity.** Shape (sketch):
   `Project = { id, name, root /* repo/cwd */, defaultWorkflowId?, integrations? /* skills+mcp bundle */, provider? /* runtime/model policy */, env? }`.
   A `ProjectStore` persists them; `Task.projectId` already references one.
2. **The engine/daemon hosts many projects at once.** Tasks are isolated per
   project: each wake runs with the project's `root` as cwd and the project's env
   injected into the `LoopFactory` (`WakeContext` gains the resolved Project). This
   is what makes "并行多个 project，project 内多任务并行" real.
3. **Worktree isolation is a future integration, not core.** Provide a worktree
   tool/provisioner so a task (or a branch) gets its own `git worktree` under the
   project root; the loop factory injects that worktree path as the wake's cwd, and
   it's torn down when the task reaches a terminal stage. This enables multi-branch
   parallel development within one project, and composes with agent-loop's
   worktree isolation. Until then, tasks in a project share the project root.

## Where it plugs in (when built)

- `createProject` API + a durable `ProjectStore` (alongside Event/Projection/Chronicle stores).
- `WakeContext` carries the resolved `Project`; `LoopFactory` reads `project.root`/`env`/`provider` to build the worker loop with the right cwd + provider (runtime ⊥ provider already supports per-wake provider choice).
- Worktree provisioning hook at wake start (or task creation) + cleanup at terminal; modeled as a registered integration so it's optional.
- Observability (`status`, chronicle) scoped per project.

## Consequences

- Multi-project is mostly additive: the kernel/engine already thread `projectId`;
  this adds the entity, isolation, and per-project defaults.
- Worktrees add lifecycle (provision/cleanup, crash-recovery of orphaned worktrees —
  the old `agent-worker` prototype already has `recoverOrphanedWakes`/worktree cleanup to port).
- Likely sequencing: lands around **M4 (subtasks/DAG + multi-project)**; the worktree
  integration can follow once the Project entity + per-project cwd exist.
