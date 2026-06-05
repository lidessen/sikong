# 0026 — Worker sandbox with privilege escalation (auto-mode), so the worker can self-verify

Status: Accepted
Date: 2026-06-05
Fixes: the non-convergence root cause behind 0024/0025; complements 0024 (gate), 0023 (conductor shell)

## Resolution (implemented 2026-06-05)

Open questions settled by the implementation:
1. **just-bash vs claude-code native bash** — *both*, per runtime. **ai-sdk** workers
   use the agent-loop project bash with a host-retry on sandbox-constrained failure
   (`createProjectTools({ sandboxEscalation })`). **claude-code** workers use their
   own native bash gated by an `onToolUse` escalation hook
   (`createEscalationOnToolUse`) that **approves** allow-listed build/test/read
   commands via a new `{ action: "approve" }` hook decision (claude bridge →
   `permissionDecision: "allow"`), so a worker in `acceptEdits` can run `swift build`
   without a prompt. Both paths share one `classifyCommand`.
2. **Classifier depth** — static deny-wins precedence: hard-block → operator
   deny/exclude → git-subcommand refinement → built-in allow → custom allow →
   built-in deny → custom classifier → default-deny.
3. **Toolchain inheritance** — the escalated/approved command runs in the host env
   (full PATH), so swift/go/bun are available.
4. **Failure detection** — `isSandboxConstrainedResult` (EACCES/bwrap/command-not-
   found for a known toolchain) triggers the ai-sdk host retry.

Enabled per worker by `permissionMode: "auto"` (auto-accept edits + auto-approve
allow-listed build/test bash); `auto` maps to the SDK's `acceptEdits` base posture
plus the escalation hook. Default workers stay `acceptEdits` (no escalation).

## Context — why the correction loop didn't converge

The grounded gate (0024) correctly *caught* the operator console's false "done" and
blocked it — but the worker couldn't **converge** to a clean build. Diagnosis: the
worker runs shell in a restricted sandbox (the agent-loop project bash / just-bash)
and **cannot run the real toolchain** (`swift build` was permission-declined,
`go build`/codesign blocked). So the worker edits **blind** — it can't compile to see
if its fix worked or introduced a new error — and only the gate (running on the host
with the toolchain) sees the errors, one per round. A blind-editing worker fixes one
gate-reported error at a time and re-introduces others → it grinds, it doesn't
converge. The fix is to let the worker **run the build itself** (self-verify before
claiming done), safely.

## Decision — model the worker shell on Claude Code's sandbox + auto-mode escalation

Give the worker a **sandbox-by-default shell with auto-mode privilege escalation**,
following the Claude Code design (researched 2026-06-05):

### Two orthogonal layers (Claude Code's split)
1. **OS-level sandbox** — *what* a command may access. macOS: **Seatbelt**
   (`sandbox-exec`); Linux: **bubblewrap** (`bwrap` + `socat`). Default: writes only
   under the project cwd, reads broad, network prompts on first new domain. Reusable:
   **`@anthropic-ai/sandbox-runtime`** (the OS wrapper, standalone), or the
   claude-code runtime's own sandboxed bash.
2. **Auto-mode decision gate** — *whether* a command runs / escalates. A classifier +
   allow/deny rules, evaluated when a command needs more than the sandbox grants.

### The escalation flow (the key part)
```
worker runs `swift build`  → sandbox blocks (no toolchain / write outside cwd)
   → detect sandbox failure (parse stderr/exit: EACCES, bwrap denied, tool missing)
   → RETRY with escalation (dangerouslyDisableSandbox) — agent-loop's Bash tool
     ALREADY exposes this parameter
   → auto-mode gate decides: auto-approve (build/test/read are safe) — or block
   → runs with the real toolchain → worker SEES the result → iterates to clean
```
So the worker can `swift build` / `go test` / `bun run test` itself, fix → rebuild →
fix → … → green, **before** requesting transition — and then the grounded gate
(0024) double-checks on the host. The gate stops staying-blocked-forever; the worker
can now actually satisfy it.

### Auto-mode classifier (bounded — Claude Code's precedence)
- **Auto-allow (escalate freely):** build/test/lint/typecheck/read-only toolchain
  commands and reads (`swift build`, `go build|test|vet`, `bun run *`, `npm/cargo`,
  `grep`, `cat`). These are the self-verify path.
- **Soft-block (need explicit intent):** destructive (`rm -rf`, `git reset --hard`),
  force-push, deploys, DB writes.
- **Hard-block (never):** exfiltration / anything outward-facing / `curl|sh` /
  network to non-allowlisted hosts / sandbox-bypass attempts.
- Config: `allowUnsandboxedCommands` (default on for dev/worker hosts; off for strict
  CI), `excludedCommands`, allow/deny lists — mirroring Claude Code's `sandbox` +
  `autoMode` settings.

### Reuse, not reinvent
- agent-loop's Bash tool already has `dangerouslyDisableSandbox` — wire the
  failure-detect → escalate retry around it (or adopt the claude-code runtime's
  native sandboxed bash, which carries the whole sandbox+permission flow).
- `@anthropic-ai/sandbox-runtime` for the OS layer if we need our own.
- The classifier is a *lightweight* allow/deny + intent check (Claude Code's full
  LLM classifier is internal and not reusable — model the concept, not the impl).

## Why this is the right fix
- It removes the **root cause** of non-convergence: the worker can finally *see* its
  build errors and iterate to green locally — no more blind edit-and-pray.
- It **completes** the grounded-gate loop (0024): worker self-verifies → gate
  double-checks on the host. Two independent verifications, both grounded.
- It is **safe**: sandbox-by-default bounds damage; escalation is allow-listed to
  build/test/read and classifier-blocked for destructive/outward — exactly Claude
  Code's proven posture, not a blanket "run anything."
- Same escalated-but-bounded shell concept the Conductor uses (0023's read/observe
  shell) — one model across worker + conductor.

## Open questions
1. **Adopt claude-code's native sandboxed bash vs add escalation to just-bash?**
   (Lean: reuse the claude-code runtime sandbox where the worker runs on claude-code;
   add the escalate-retry to the project bash otherwise.)
2. **Classifier depth** — start with a static allow/deny list (build/test/read auto,
   destructive/outward blocked); grow only if needed.
3. **Per-project toolchain** — the escalated env must actually have swift/go/bun
   (the host does; ensure the worker's escalated shell inherits it).
4. **Failure-detection heuristics** — regex on stderr/exit (EACCES outside cwd, bwrap
   denied, "command not found" for a known toolchain) → escalate; else surface.

## Consequences
- Workers stop shipping blind: they build/test before claiming done, so the gate's
  job becomes confirmation rather than first discovery — and tasks like the operator
  console can actually converge.
- One bounded sandbox-escalation model spans worker + conductor; implemented by
  sikong (reusing agent-loop's existing `dangerouslyDisableSandbox` + the claude-code
  sandbox), gated by 0024 once built.
