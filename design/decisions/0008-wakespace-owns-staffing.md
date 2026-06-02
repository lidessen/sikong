# ADR 0008: Wakespace Owns Staffing; the Client Only States, Accepts, Supervises

Status: Accepted

Date: 2026-06-02

Related: builds on [0007](0007-coding-belongs-to-the-agent.md) (coding lives in the
agent); promotes part of the "rich routing / model selection policy" non-goal in
`../areas/workspace-engine.md` into the kernel, in a deliberately thin form.

## Context

ADR 0007 fixed the *how*-boundary: a worker (the plant) carries its own ability;
wakespace (the controller) never teaches it how to work. This ADR fixes the
*who*-boundary, which the same engineering-cybernetics framing demands.

Today the client must run `worker create` and `worker default`, and may pass
`--worker` per task. That makes the client do the company's staffing — the wrong
role. In a company, the client states a requirement, accepts the deliverable, and
supervises; it does not pick which engineer writes the code. Picking the worker is
internal resource allocation — the controller's own control law, not an external
input.

Note this is **not** a return of the ADR-0007 problem. "How to code" is the
plant's internals and stays out of wakespace. "Who is assigned to a task" is
staffing — a coordination function that legitimately belongs in the controller. A
worker capability tag is staffing metadata (like labeling an engineer "backend"),
matched generically in the management layer; the engine never sees it.

## Decision

Three layers, with the client only at the boundary:

- **Client** — reference input + acceptance: states the requirement, reviews the
  deliverable, supervises/steers. Never selects a worker.
- **Wakespace** — the controller: intake/research, plan, create & decompose tasks,
  **assign the worker (hire)**, follow up, escalate.
- **Agent/worker** — the plant: executes with its own ability.

Staffing rules:

1. **Provision vs assign.** The operator provisions the workforce *once* — by
   setting provider keys in the environment (and/or installing a runtime such as
   `claude`). Per-task *assignment* is wakespace's job, every task. wakespace
   cannot conjure credentials, so provisioning is the only external seam.
2. **Auto-discovered roster.** When no workers are explicitly registered, wakespace
   builds its roster from the environment (`worker discover`): one worker per usable
   runtime × configured provider, with the provider's default model. The client
   does nothing but set keys.
3. **Capability-matched assignment.** A worker carries optional `roles` (capability
   tags); a workflow carries an optional `workerRole` (the capability a task on it
   needs). At hire time wakespace prefers a worker whose roles include the
   workflow's `workerRole`, falling back to any available worker. This is a thin
   deterministic match, not a smart router.
4. **Client surface.** The everyday path needs no worker management:
   `create "<requirement>"` → intake → run → review. `--worker` and
   `worker default` remain as an optional supervisor override, not a prerequisite.

Default role inference (data, not engine logic): a `claude-code` worker carries its
own coding interface, so it is tagged `["coding", "general"]`; an `ai-sdk` worker is
tagged `["general"]`. The built-in `development` workflow declares
`workerRole: "coding"`, so coding work is staffed to a coding-agent worker when one
is available — the "use a real coding agent for coding" outcome, reached by
staffing rather than by scaffolding.

## Consequences

- The client interacts with wakespace as a company: requirement in, result out.
- Worker selection is deterministic, auditable, and lives in the management layer
  (`workspace.ts` / `worker.ts`), not the engine — the engine stays task-agnostic
  and never references roles or coding.
- Graceful degradation: if only an ai-sdk worker is available, a coding task is
  still assigned to it (no `coding`-roled worker exists); it attempts the work with
  `agent-loop`'s generic tools.
- Promotes a slice of the "model selection policy" non-goal into the kernel, kept
  intentionally thin (capability match, not weighting/cost/routing heuristics).

## Implementation Notes

- `Worker` gains optional `roles?: readonly string[]`. Add pure helpers
  `defaultRolesForRuntime(runtime)`, `workerHasRole(worker, role)`, and a pure
  `selectWorker(roster, { workerId?, projectDefault?, workspaceDefault?, workerRole? })`
  — unit-tested in isolation.
- `discoveredRoster()` turns `discoverWorkers()` (usable runtime × configured
  provider) into concrete `Worker`s with the provider default model and inferred
  roles, ordered coding-capable first.
- `WorkflowDef` gains optional `workerRole?: string`; `development` sets `"coding"`.
- `workspace.ts` builds the roster (explicit workers, else discovered) and replaces
  the `hire` closure with `selectWorker`, reading `ctx.workflow.workerRole`.
- CLI: `--worker` stays an optional override; `worker list` shows the effective
  (explicit-or-discovered) roster so the operator can see who will be hired; the
  no-worker error guides toward setting a provider key, not toward `worker create`.

## Open Questions

- Should general (non-coding) tasks prefer a cheaper `general`-only worker rather
  than the first (coding-capable) roster entry? Deferred — would add weighting.
- Should assignment be pinned durably onto the task at creation (event) rather than
  re-resolved per wake? Re-resolution over a stable roster is deterministic enough
  for now; pin if rosters start changing mid-task.
- The autonomous lead/PM layer (an agent that owns research+plan+decompose+follow-up
  so the client talks only to it) is the next step, recorded separately when built.
