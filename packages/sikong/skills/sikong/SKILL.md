---
name: sikong
description: Best practices for driving sikong (司空), the durable agent-workspace coordination CLI over agent-loop — how to create and run tasks, choose workflows, gate completion with grounded and lead-authored acceptance checks, configure workers (auto-mode self-verify), and avoid the common pitfalls. Use when working in a sikong workspace, when you see a `.sikong/` directory or the `sikong` CLI, or when orchestrating multi-agent coding/design/release work.
---

# Sikong (司空) — Usage & Best Practices

Sikong is a **durable, task-agnostic coordination layer** over agent-loop. You (the
lead/client) state requirements, accept results, and supervise; **workers** (LLM
runtimes) do the actual coding/design. The cybernetic stance: sikong is the
controller, each worker is a black-box plant — you act on its inputs/outputs and
feedback, you don't rebuild its hands. Coding lives in the worker; sikong stays
coordination.

## When to use this skill

- You're driving sikong tasks, or asked to "conduct sikong" / "vibe-code via sikong".
- You're orchestrating multi-agent coding, design, or release work.
- You see a `.sikong/` workspace or the `sikong` CLI on PATH.

## Mental model

- **Project** — the container a task lives under: a root dir, default workflow,
  default worker, optional sandbox config.
- **Workflow** — ordered **stages**, each with an entry **guard** and optional
  **acceptance** checks. Built-ins: `development`, `design`, `release`, `general`.
- **Task** — an instance on a workflow. It advances stage→stage only when the next
  stage's guard passes. It finishes by being *admitted* into a terminal `done`
  stage — there is no "mark complete" an agent can call.
- **Wake** — one bounded agent-loop run per cycle. State (an append-only JSONL event
  log + a projection) is durable across wakes; the worker reads the projection.
- **Worker** — runtime · provider · model · permissionMode (e.g.
  `claude-code · deepseek · deepseek-v4-pro`, `auto`).
- **Acceptance gate** — deterministic checks (`command` / `fileExists` / `grep` /
  `projectGate`) the **engine** runs before a stage advances. Completion is
  *verified*, not self-reported.

## Core commands

```sh
# drive
sikong create "<request>" --workflow development --project <id> [--worker <id>] \
       [--acceptance '<json-array>'] [--id <id>]
sikong design  "<request>" --project <id> [--frame "<text>"]   # philosophy-driven design
sikong release "<request>" --project <id> [--ref <ref>]
sikong run --task <id> [--wake-timeout <seconds>]              # drive the task's wakes
sikong submit <id> set-field <f> <v> | transition [reason] | block <reason> | unblock | cancel [reason]
sikong register <workflow.yaml|json>                          # custom workflow

# projects / workers
sikong project create <id> [--root <path>] [--workflow <id>] [--worker <id>] [--permission <mode>]
sikong worker create <id> --runtime <r> --provider <p> --model <m> [--permission <mode>]
sikong worker default <id>

# read / observe
sikong overview [--project <id>]          # dashboard: tasks by project/status
sikong task <id>                          # one task's stage, fields, recent events
sikong chronicle [--task <id>] [-n N]     # activity log (wakes, transitions, acceptance verdicts)
sikong usage [--project <id>]             # tokens + cost (5h/7d/30d)
sikong watch [--project <id>]             # live dashboard
sikong inspect wait --task <id> [--after <seq>] [--timeout <ms>]
```

Agent-facing read commands default to JSON; add `--text` for human output.

## Best practices

1. **Conduct, don't hand-edit.** State the requirement; let a worker implement;
   then review and gate. Reserve direct edits for trivial one-off ops where
   spinning up a task would be absurd (and say so).

2. **Gate spec-critical work with lead-authored acceptance** (the most important
   rule). A worker that authors its own tests can pass `projectGate`
   (typecheck + test) while leaving the requirement unmet. Bind checks it *cannot*
   redefine:
   ```sh
   sikong create "..." --workflow development --project p \
     --acceptance '[{"kind":"command","description":"the X case works","cmd":"grep -q FOO src/x.ts"}]'
   ```
   When delegating, the lead attaches them per child: `create_subtask({ acceptance: [...] })`.
   They merge with the stage's static acceptance at the gate and are immutable by the
   worker. **Then externally verify the specific required cases yourself** — "all
   tests pass" from a worker that wrote the tests is not sufficient evidence.

3. **Keep a grounded gate on verify.** The `development` workflow's verify stage
   carries `projectGate` (host-run typecheck + test). Don't remove it; it's the
   floor that stops false-"done".

4. **Give workers auto-mode so they self-verify.** A worker in
   `permissionMode: auto` auto-accepts edits *and* auto-approves allow-listed
   build/test/read commands, so it can run `swift build` / `go test` /
   `bun run test` itself and converge — instead of editing blind. Default
   `acceptEdits` workers can't run the build in headless and will grind.

5. **Decompose explicitly when delegating.** Spell out the exact subtasks and their
   `dependsOn` order; a lead left to re-decompose can drift. Two subtasks touching
   the same files must chain via `dependsOn` or each set `isolate: true`.

6. **One `sikong run` at a time per workspace** (single-writer). Serialize your
   runs; concurrent runs race the write lock.

7. **Let adaptive wake timeout run unless you need an explicit cap.** Default
   `sikong run` computes a per-wake budget from deterministic work units
   (stage outputs, tools, acceptance checks, team size, effort). Use
   `--wake-timeout` only as an override for tests, smokes, or emergency bounds.

8. **Set effort per stage/subtask** (`low`/`medium`/`high`/`max`). Dial up for
   design/hard reasoning, down for rote build/verify. Default is medium with
   escalation.

9. **Externalize state for recovery.** Everything you need is in git + `sikong
   overview` + `sikong chronicle`. After a milestone, write a short worklog. To
   resume, read those, not your memory.

10. **If a run exits leaving a task `in_progress` mid-flight, just re-drive it**
    (`sikong run --task <id>`). A wake timeout or a process exit can strand a task;
    re-driving resumes from the durable state.

## Workflows

- **development** (adaptive): `design → plan → build → verify → done`. Solo OR
  delegate (`create_subtask`) — the lead decides. Verify is gated by `projectGate`.
- **design** (philosophy-driven): `frame → language → derive → assemble → review`.
  Selects a *design language* from `design/design-language-catalog.md` via a
  philosophy-altitude dialectic, then derives every token 因地制宜 (from context),
  and assembles real code. The agent can't see pixels — final visual approval is the
  owner's.
- **release**: select a stable ref → gate → tag → lead-approve → publish → confirm.
- **general**: a minimal single-stage workflow for non-coding tasks.

Register your own with `sikong register <workflow.yaml>` — give stages an
`acceptance` list and gate the terminal stage on `{ op: "acceptancePassed" }`.

## Gotchas

- **Workers do the easy 80% and drop the hard requirement** — and may write tests
  that match what they built. Lead-authored acceptance + external verification of
  the *specific* cases is the countermeasure.
- **Acceptance is only as good as its checks.** A too-literal `grep` can
  false-*negative* a correct implementation (e.g. a reserved word that must be
  backticked); a missing check can't catch a missing feature. Write checks against
  real-language idioms, and prefer behavioral checks over string-presence ones.
- **The lead is a strategist, not a retry button.** On a stuck/failing task,
  diagnose, research, re-decompose, switch model/effort, or judge fixable-vs-abandon
  — don't blindly re-run the same wake.

## Install this skill

```sh
npx skills add lidessen/sikong --skill sikong
```
(Part of the open agent-skills ecosystem — works with Claude Code, Codex, Cursor,
and others. Browse skills at https://skills.sh/.)
